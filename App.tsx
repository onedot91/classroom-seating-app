import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Settings as SettingsIcon, HomeIcon, RefreshCw, Trash2, PlusCircle, Sparkles, Layers, Move, Eraser, Info, Users, ChevronUp, ChevronDown, Camera, Save, History, X, Play, Maximize2, AlertCircle, Type, Smile } from 'lucide-react';
import { ClassroomConfig, ViewType, Seat, EditModeType, Student, Gender, Position, HistoryItem, StudentSnapshot } from './types';
import { audioService } from './services/audioService';
import * as htmlToImage from 'html-to-image';

type ForbiddenPairRule = {
  id: string;
  firstStudentId: string;
  secondStudentId: string;
};

type StudentGroupRule = {
  id: string;
  studentIds: string[];
};

type FixedSeatRule = {
  id: string;
  studentId: string;
  seatKey: string;
};

type ShuffleSettings = {
  genderBalance: boolean;
  avoidDuplicate: boolean;
  forbiddenPairs: ForbiddenPairRule[];
  forbiddenGroups: StudentGroupRule[];
  fixedSeats: FixedSeatRule[];
  frontOnly: string[];
  noBackRow: string[];
  noSoloSeat: string[];
};

type ShuffleResultStatus = 'all' | 'history_relaxed' | 'rules_relaxed';
type PreparedShuffleResult = { positions: Position[]; status: ShuffleResultStatus };

type CompiledShuffleRules = {
  hasHardRules: boolean;
  seatIndexByKey: Map<string, number>;
  adjacencyBySeatIndex: number[][];
  pairGroupBySeatIndex: Map<number, number>;
  frontRow: number;
  backRow: number;
  allowedSeatIndicesByStudent: number[][];
  fixedSeatIndexByStudent: Map<number, number>;
  forbiddenPairTargets: Map<number, Set<number>>;
  forbiddenGroupTargets: Map<number, Set<number>>;
};

type LayoutPerspective = 'student' | 'teacher';
type SaveModalAction = 'history' | 'capture';

const DEFAULT_STUDENTS: Student[] = Array.from({ length: 22 }, (_, i) => ({
  id: `default-student-${i + 1}`,
  name: `학생${i + 1}`,
  gender: 'M'
}));

const DEFAULT_SHUFFLE_SETTINGS: ShuffleSettings = {
  genderBalance: false,
  avoidDuplicate: true,
  forbiddenPairs: [],
  forbiddenGroups: [],
  fixedSeats: [],
  frontOnly: [],
  noBackRow: [],
  noSoloSeat: [],
};
const SECRET_SHUFFLE_UNLOCK_TAPS = 3;
const SECRET_SHUFFLE_UNLOCK_WINDOW_MS = 1400;
const FIXED_SEAT_MISS_PENALTY = 4;
const SHUFFLE_SEARCH_DEADLINE_MS = 180;
const SHUFFLE_BACKTRACK_NODE_LIMIT = 12000;

const normalizeStudentName = (name: string) => name.trim().toLowerCase();
const createSeatKey = (seat: Position) => `${seat.r},${seat.c}`;
const createStudentId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `student-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
};

const createStudent = (name: string, gender: Gender = 'M'): Student => ({
  id: createStudentId(),
  name,
  gender,
});

const dedupeStudentNames = (names: string[]) => {
  const seen = new Set<string>();
  return names.filter((name) => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    const key = normalizeStudentName(trimmed);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const createRuleId = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

const shuffleArray = <T,>(items: T[]): T[] => {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const swapIndex = Math.floor(Math.random() * (i + 1));
    [next[i], next[swapIndex]] = [next[swapIndex], next[i]];
  }
  return next;
};
const getNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const buildDerangedPositions = (positions: Position[], maxAttempts = 24): Position[] | null => {
  if (positions.length <= 1) return null;

  const indices = positions.map((_, index) => index);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const shuffledIndices = shuffleArray(indices);
    if (shuffledIndices.every((seatIndex, studentIndex) => seatIndex !== studentIndex)) {
      return shuffledIndices.map((seatIndex) => positions[seatIndex]);
    }
  }

  const repairedIndices = shuffleArray(indices);
  const fixedPointIndices = repairedIndices
    .map((seatIndex, studentIndex) => (seatIndex === studentIndex ? studentIndex : -1))
    .filter((index) => index >= 0);

  if (fixedPointIndices.length === 0) {
    return repairedIndices.map((seatIndex) => positions[seatIndex]);
  }

  if (fixedPointIndices.length === 1) {
    const fixedIndex = fixedPointIndices[0];
    const swapIndex = fixedIndex === 0 ? 1 : 0;
    [repairedIndices[fixedIndex], repairedIndices[swapIndex]] = [repairedIndices[swapIndex], repairedIndices[fixedIndex]];
    return repairedIndices.map((seatIndex) => positions[seatIndex]);
  }

  const fixedSeatIndices = fixedPointIndices.map((studentIndex) => repairedIndices[studentIndex]);
  fixedPointIndices.forEach((studentIndex, offset) => {
    repairedIndices[studentIndex] = fixedSeatIndices[(offset + 1) % fixedSeatIndices.length];
  });

  return repairedIndices.map((seatIndex) => positions[seatIndex]);
};

const normalizeStudents = (students: Student[]) => students.map((student) => ({
  ...student,
  id: typeof student.id === 'string' && student.id.trim() ? student.id : createStudentId(),
}));

const sanitizeShuffleSettings = (settings: ShuffleSettings, students: Student[], positions: Position[] = []) => {
  const validStudentIds = new Set(students.map((student) => student.id));
  const validSeatKeys = new Set(positions.map((position) => createSeatKey(position)));
  const hasSeatCatalog = validSeatKeys.size > 0;
  const normalizeIdList = (ids: string[]) => [...new Set(ids.filter((id) => validStudentIds.has(id)))];

  const forbiddenPairs = settings.forbiddenPairs
    .map((rule) => ({
      ...rule,
      firstStudentId: validStudentIds.has(rule.firstStudentId) ? rule.firstStudentId : '',
      secondStudentId: validStudentIds.has(rule.secondStudentId) ? rule.secondStudentId : '',
    }))
    .filter((rule) => rule.firstStudentId && rule.secondStudentId && rule.firstStudentId !== rule.secondStudentId);

  const forbiddenGroups = settings.forbiddenGroups
    .map((rule) => ({
      ...rule,
      studentIds: normalizeIdList(rule.studentIds),
    }))
    .filter((rule) => rule.studentIds.length >= 2);

  const usedFixedSeatStudentIds = new Set<string>();
  const usedFixedSeatKeys = new Set<string>();
  const fixedSeats = settings.fixedSeats
    .map((rule) => ({
      ...rule,
      studentId: validStudentIds.has(rule.studentId) ? rule.studentId : '',
      seatKey: typeof rule.seatKey === 'string' && rule.seatKey.trim() && (!hasSeatCatalog || validSeatKeys.has(rule.seatKey))
        ? rule.seatKey
        : '',
    }))
    .filter((rule) => {
      if (!rule.studentId || !rule.seatKey) return false;
      if (usedFixedSeatStudentIds.has(rule.studentId) || usedFixedSeatKeys.has(rule.seatKey)) return false;
      usedFixedSeatStudentIds.add(rule.studentId);
      usedFixedSeatKeys.add(rule.seatKey);
      return true;
    });

  return {
    ...DEFAULT_SHUFFLE_SETTINGS,
    ...settings,
    forbiddenPairs,
    forbiddenGroups,
    fixedSeats,
    frontOnly: normalizeIdList(settings.frontOnly),
    noBackRow: normalizeIdList(settings.noBackRow),
    noSoloSeat: normalizeIdList(settings.noSoloSeat),
  };
};

const GROUP_COLORS = [
  'bg-white border-stone-200', 
  'bg-rose-50 border-rose-400',
  'bg-blue-50 border-blue-400',
  'bg-emerald-50 border-emerald-400',
  'bg-amber-50 border-amber-400',
  'bg-violet-50 border-violet-400',
  'bg-orange-50 border-orange-400',
  'bg-cyan-50 border-cyan-200',
  'bg-indigo-50 border-indigo-200',
];

const GROUP_BADGE_COLORS = [
  'bg-stone-400',
  'bg-rose-500',
  'bg-blue-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-orange-500',
  'bg-cyan-500',
  'bg-indigo-500',
];

const GROUP_AREA_COLORS = [
  '#e7e5e4',
  '#fecdd3',
  '#bfdbfe',
  '#a7f3d0',
  '#fde68a',
  '#ddd6fe',
  '#fdba74',
  '#67e8f9',
  '#c7d2fe',
];

const App: React.FC = () => {
  const [view, setView] = useState<ViewType>('layout');
  const [editMode, setEditMode] = useState<EditModeType>('none');
  const [selectedGroupId, setSelectedGroupId] = useState<number>(1);
  const [selectedPairSeat, setSelectedPairSeat] = useState<{r: number, c: number} | null>(null);
  const [isShuffling, setIsShuffling] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [showCelebration, setShowCelebration] = useState(false);
  const [shufflingOffsets, setShufflingOffsets] = useState<Record<string, { x: number, y: number }>>({});
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ type: 'delete' | 'restore', item: HistoryItem } | null>(null);
  const [isCoarsePointerDevice, setIsCoarsePointerDevice] = useState(false);
  
  // 모바일 터치 이동을 위한 선택된 좌석 상태
  const [selectedSeat, setSelectedSeat] = useState<{r: number, c: number} | null>(null);

  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [newRecordTitle, setNewRecordTitle] = useState('');
  const [saveModalAction, setSaveModalAction] = useState<SaveModalAction>('history');
  const [layoutPerspective, setLayoutPerspective] = useState<LayoutPerspective>('student');
  const [isResetSettingsConfirmOpen, setIsResetSettingsConfirmOpen] = useState(false);
  const hiddenShuffleUnlockTapCountRef = useRef(0);
  const hiddenShuffleUnlockTimerRef = useRef<number | null>(null);
  
  const STORAGE_KEY = 'classroom_history_v18';
  const CONFIG_KEY = 'classroom_config_v18';

  const [history, setHistory] = useState<HistoryItem[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  });

  const normalizeConfig = (raw: Partial<ClassroomConfig>): ClassroomConfig => {
    const cols = 6;
    const students = raw.students && raw.students.length > 0 ? normalizeStudents(raw.students) : DEFAULT_STUDENTS.map((student) => ({ ...student }));
    const positions = raw.positions && raw.positions.length > 0
      ? raw.positions
      : students.map((_, i) => ({ r: Math.floor(i / cols), c: i % cols }));

    return {
      students,
      positions,
      groupMap: raw.groupMap || {},
      pairMap: raw.pairMap || {},
    };
  };

  const [config, setConfig] = useState<ClassroomConfig>(() => {
    const saved = localStorage.getItem(CONFIG_KEY);
    if (saved) { 
      try { 
        return normalizeConfig(JSON.parse(saved) as Partial<ClassroomConfig>);
      } catch (e) { console.error(e); } 
    }
    return normalizeConfig({});
  });

  // SettingsView 상태를 App으로 끌어올림
  const [editingStudents, setEditingStudents] = useState<Student[]>([]);
  const [shuffleSettings, setShuffleSettings] = useState<ShuffleSettings>(() => {
    const students = config.students;
    const studentIdByNormalizedName = new Map<string, string[]>();
    students.forEach((student) => {
      const key = normalizeStudentName(student.name);
      const existing = studentIdByNormalizedName.get(key) || [];
      existing.push(student.id);
      studentIdByNormalizedName.set(key, existing);
    });
    const mapLegacyNamesToIds = (names: string[]) => {
      const consumed = new Set<string>();
      const resolved: string[] = [];
      names.forEach((name) => {
        const candidates = studentIdByNormalizedName.get(normalizeStudentName(name)) || [];
        const nextId = candidates.find((studentId) => !consumed.has(studentId));
        if (!nextId) return;
        consumed.add(nextId);
        resolved.push(nextId);
      });
      return resolved;
    };

    const saved = localStorage.getItem('classroom_shuffle_settings_v3') || localStorage.getItem('classroom_shuffle_settings_v2');
    if (!saved) return DEFAULT_SHUFFLE_SETTINGS;

    try {
      const parsed = JSON.parse(saved) as Partial<ShuffleSettings> & {
        forbiddenPairs?: Array<Partial<ForbiddenPairRule> & { first?: string; second?: string }>;
        forbiddenGroups?: Array<Partial<StudentGroupRule> & { names?: string[] }>;
        fixedSeats?: Array<Partial<FixedSeatRule> & { seat?: Partial<Position>; r?: number; c?: number }>;
      };

      const resolveFixedSeatKey = (rule: Partial<FixedSeatRule> & { seat?: Partial<Position>; r?: number; c?: number }) => {
        if (typeof rule?.seatKey === 'string') return rule.seatKey;
        if (typeof rule?.seat?.r === 'number' && typeof rule?.seat?.c === 'number') {
          return createSeatKey({ r: rule.seat.r, c: rule.seat.c });
        }
        if (typeof rule?.r === 'number' && typeof rule?.c === 'number') {
          return createSeatKey({ r: rule.r, c: rule.c });
        }
        return '';
      };

      const forbiddenPairs = Array.isArray(parsed.forbiddenPairs)
        ? parsed.forbiddenPairs.map((rule) => {
            const legacyIds = mapLegacyNamesToIds([rule?.first || '', rule?.second || '']);
            return {
              id: typeof rule?.id === 'string' ? rule.id : createRuleId('pair-rule'),
              firstStudentId: typeof rule?.firstStudentId === 'string' ? rule.firstStudentId : (legacyIds[0] || ''),
              secondStudentId: typeof rule?.secondStudentId === 'string' ? rule.secondStudentId : (legacyIds[1] || ''),
            };
          })
        : [];
      const forbiddenGroups = Array.isArray(parsed.forbiddenGroups)
        ? parsed.forbiddenGroups.map((rule) => ({
            id: typeof rule?.id === 'string' ? rule.id : createRuleId('group-rule'),
            studentIds: Array.isArray(rule?.studentIds)
              ? rule.studentIds.filter((studentId): studentId is string => typeof studentId === 'string')
              : mapLegacyNamesToIds(Array.isArray(rule?.names) ? rule.names.filter((name): name is string => typeof name === 'string') : []),
          }))
        : [];
      const frontOnly = Array.isArray(parsed.frontOnly)
        ? (typeof parsed.frontOnly[0] === 'string' && students.some((student) => student.id === parsed.frontOnly[0])
            ? parsed.frontOnly.filter((studentId): studentId is string => typeof studentId === 'string')
            : mapLegacyNamesToIds(parsed.frontOnly.filter((name): name is string => typeof name === 'string')))
        : [];
      const noBackRow = Array.isArray(parsed.noBackRow)
        ? (typeof parsed.noBackRow[0] === 'string' && students.some((student) => student.id === parsed.noBackRow[0])
            ? parsed.noBackRow.filter((studentId): studentId is string => typeof studentId === 'string')
            : mapLegacyNamesToIds(parsed.noBackRow.filter((name): name is string => typeof name === 'string')))
        : [];
      const noSoloSeat = Array.isArray(parsed.noSoloSeat)
        ? (typeof parsed.noSoloSeat[0] === 'string' && students.some((student) => student.id === parsed.noSoloSeat[0])
            ? parsed.noSoloSeat.filter((studentId): studentId is string => typeof studentId === 'string')
            : mapLegacyNamesToIds(parsed.noSoloSeat.filter((name): name is string => typeof name === 'string')))
        : [];
      const fixedSeats = Array.isArray(parsed.fixedSeats)
        ? parsed.fixedSeats.map((rule) => ({
            id: typeof rule?.id === 'string' ? rule.id : createRuleId('fixed-seat-rule'),
            studentId: typeof rule?.studentId === 'string' ? rule.studentId : '',
            seatKey: resolveFixedSeatKey(rule),
          }))
        : [];

      return sanitizeShuffleSettings({
        ...DEFAULT_SHUFFLE_SETTINGS,
        ...parsed,
        forbiddenPairs,
        forbiddenGroups,
        fixedSeats,
        frontOnly,
        noBackRow,
        noSoloSeat,
      }, students, config.positions);
    } catch (e) {
      return DEFAULT_SHUFFLE_SETTINGS;
    }
  });

  const resetHiddenShuffleUnlock = useCallback(() => {
    hiddenShuffleUnlockTapCountRef.current = 0;

    if (hiddenShuffleUnlockTimerRef.current !== null) {
      window.clearTimeout(hiddenShuffleUnlockTimerRef.current);
      hiddenShuffleUnlockTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    resetHiddenShuffleUnlock();
  }, [resetHiddenShuffleUnlock]);

  useEffect(() => {
    if (view !== 'settings-students') {
      resetHiddenShuffleUnlock();
    }
  }, [resetHiddenShuffleUnlock, view]);

  const createStudentSnapshots = (sourceConfig: ClassroomConfig): StudentSnapshot[] => {
    const seatToStudentIndex = new Map<string, number>(
      sourceConfig.positions.map((pos, index) => [`${pos.r},${pos.c}`, index])
    );

    const pairMembersById: Record<number, string[]> = {};
    Object.entries(sourceConfig.pairMap).forEach(([seatKey, pairId]) => {
      if (!pairMembersById[pairId]) pairMembersById[pairId] = [];
      pairMembersById[pairId].push(seatKey);
    });

    return sourceConfig.students.map((student, index) => {
      const seat = sourceConfig.positions[index] || { r: 0, c: 0 };
      const seatKey = `${seat.r},${seat.c}`;
      const pairId = sourceConfig.pairMap[seatKey];
      const partnerSeatKey = pairId ? (pairMembersById[pairId] || []).find((key) => key !== seatKey) : undefined;
      const partnerStudentIndex = partnerSeatKey ? seatToStudentIndex.get(partnerSeatKey) : undefined;
      const pairPartner = partnerStudentIndex !== undefined ? sourceConfig.students[partnerStudentIndex] : undefined;
      const pairPartnerSeat = partnerStudentIndex !== undefined ? sourceConfig.positions[partnerStudentIndex] : undefined;

      return {
        name: student.name,
        gender: student.gender,
        seat,
        pairId,
        pairPartnerName: pairPartner?.name,
        pairPartnerSeat,
      };
    });
  };

  const createLayoutSignature = (sourceConfig: ClassroomConfig): string => {
    const normalizedSeats = sourceConfig.students
      .map((student, index) => {
        const seat = sourceConfig.positions[index] || { r: 0, c: 0 };
        return {
          name: student.name,
          gender: student.gender,
          r: seat.r,
          c: seat.c,
        };
      })
      .sort((a, b) => {
        if (a.r !== b.r) return a.r - b.r;
        if (a.c !== b.c) return a.c - b.c;
        if (a.name < b.name) return -1;
        if (a.name > b.name) return 1;
        return a.gender < b.gender ? -1 : a.gender > b.gender ? 1 : 0;
      });

    const pairMembersById: Record<number, string[]> = {};
    Object.entries(sourceConfig.pairMap).forEach(([seatKey, pairId]) => {
      if (!pairMembersById[pairId]) pairMembersById[pairId] = [];
      pairMembersById[pairId].push(seatKey);
    });

    const normalizedPairs = Object.values(pairMembersById)
      .filter((members) => members.length >= 2)
      .map((members) => [...members].sort())
      .sort((a, b) => a.join('|').localeCompare(b.join('|')))
      .map((members) => members.join(','));

    return JSON.stringify({
      seats: normalizedSeats,
      pairs: normalizedPairs,
      studentCount: sourceConfig.students.length,
    });
  };

  const createPairNameSignature = (sourceConfig: ClassroomConfig): string[] => {
    const seatToStudentName = new Map<string, string>();
    sourceConfig.students.forEach((student, index) => {
      const seat = sourceConfig.positions[index] || { r: 0, c: 0 };
      seatToStudentName.set(`${seat.r},${seat.c}`, student.name);
    });

    const pairMembersById: Record<number, string[]> = {};
    Object.entries(sourceConfig.pairMap).forEach(([seatKey, pairId]) => {
      const studentName = seatToStudentName.get(seatKey);
      if (!studentName) return;
      if (!pairMembersById[pairId]) pairMembersById[pairId] = [];
      pairMembersById[pairId].push(studentName);
    });

    const pairSignatures: string[] = [];
    Object.values(pairMembersById).forEach((members) => {
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          pairSignatures.push([members[i], members[j]].sort().join('||'));
        }
      }
    });

    return pairSignatures.sort();
  };

  const savedLayoutSignatures = useMemo(() => {
    const set = new Set<string>();
    history.forEach((item) => {
      const normalizedItemConfig = normalizeConfig(item.config);
      set.add(createLayoutSignature(normalizedItemConfig));
    });
    return set;
  }, [history]);

  const savedPairSignatures = useMemo(() => {
    const set = new Set<string>();
    history.forEach((item) => {
      const normalizedItemConfig = normalizeConfig(item.config);
      createPairNameSignature(normalizedItemConfig).forEach((signature) => {
        set.add(signature);
      });
    });
    return set;
  }, [history]);

  const buildShuffleRuleState = (baseConfig: ClassroomConfig, settings: ShuffleSettings): CompiledShuffleRules => {
    const studentIndexById = new Map<string, number>();
    baseConfig.students.forEach((student, index) => {
      studentIndexById.set(student.id, index);
    });

    const resolveStudentIndices = (studentIds: string[]) => {
      const indices = new Set<number>();
      studentIds.forEach((studentId) => {
        const matched = studentIndexById.get(studentId);
        if (matched !== undefined) indices.add(matched);
      });
      return [...indices];
    };

    const seatIndexByKey = new Map<string, number>();
    baseConfig.positions.forEach((seat, index) => {
      seatIndexByKey.set(`${seat.r},${seat.c}`, index);
    });

    const adjacencyBySeatIndex = baseConfig.positions.map((seat, seatIndex) => {
      const neighbors = [
        seatIndexByKey.get(`${seat.r - 1},${seat.c}`),
        seatIndexByKey.get(`${seat.r + 1},${seat.c}`),
        seatIndexByKey.get(`${seat.r},${seat.c - 1}`),
        seatIndexByKey.get(`${seat.r},${seat.c + 1}`),
      ].filter((value): value is number => value !== undefined);
      return neighbors;
    });

    const pairGroupBySeatIndex = new Map<number, number>();
    Object.entries(baseConfig.pairMap).forEach(([seatKey, pairId]) => {
      const seatIndex = seatIndexByKey.get(seatKey);
      if (seatIndex !== undefined) pairGroupBySeatIndex.set(seatIndex, pairId);
    });

    const rows = baseConfig.positions.map((seat) => seat.r);
    const frontRow = rows.length > 0 ? Math.min(...rows) : 0;
    const backRow = rows.length > 0 ? Math.max(...rows) : 0;

    const seatsWithSideNeighbor = new Set<number>();
    baseConfig.positions.forEach((seat, seatIndex) => {
      if (seatIndexByKey.has(`${seat.r},${seat.c - 1}`) || seatIndexByKey.has(`${seat.r},${seat.c + 1}`)) {
        seatsWithSideNeighbor.add(seatIndex);
      }
    });

    const frontOnlyStudents = new Set(resolveStudentIndices(settings.frontOnly));
    const noBackRowStudents = new Set(resolveStudentIndices(settings.noBackRow));
    const noSoloSeatStudents = new Set(resolveStudentIndices(settings.noSoloSeat));
    const fixedSeatIndexByStudent = new Map<number, number>();

    settings.fixedSeats.forEach((rule) => {
      const studentIndex = studentIndexById.get(rule.studentId);
      const seatIndex = seatIndexByKey.get(rule.seatKey);
      if (studentIndex === undefined || seatIndex === undefined) return;
      fixedSeatIndexByStudent.set(studentIndex, seatIndex);
    });

    const allowedSeatIndicesByStudent = baseConfig.students.map((_, studentIndex) => {
      return baseConfig.positions
        .map((seat, seatIndex) => ({ seat, seatIndex }))
        .filter(({ seat, seatIndex }) => {
          if (frontOnlyStudents.has(studentIndex) && seat.r !== frontRow) return false;
          if (noBackRowStudents.has(studentIndex) && seat.r === backRow) return false;
          if (noSoloSeatStudents.has(studentIndex) && !seatsWithSideNeighbor.has(seatIndex)) return false;
          if (fixedSeatIndexByStudent.has(studentIndex) && fixedSeatIndexByStudent.get(studentIndex) !== seatIndex) return false;
          return true;
        })
        .map(({ seatIndex }) => seatIndex);
    });

    const forbiddenPairTargets = new Map<number, Set<number>>();
    settings.forbiddenPairs.forEach((rule) => {
      const firstIndices = resolveStudentIndices([rule.firstStudentId]);
      const secondIndices = resolveStudentIndices([rule.secondStudentId]);
      firstIndices.forEach((firstIndex) => {
        secondIndices.forEach((secondIndex) => {
          if (firstIndex === secondIndex) return;
          if (!forbiddenPairTargets.has(firstIndex)) forbiddenPairTargets.set(firstIndex, new Set<number>());
          if (!forbiddenPairTargets.has(secondIndex)) forbiddenPairTargets.set(secondIndex, new Set<number>());
          forbiddenPairTargets.get(firstIndex)!.add(secondIndex);
          forbiddenPairTargets.get(secondIndex)!.add(firstIndex);
        });
      });
    });

    const forbiddenGroupTargets = new Map<number, Set<number>>();
    settings.forbiddenGroups.forEach((rule) => {
      const members = resolveStudentIndices(rule.studentIds);
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          const firstIndex = members[i];
          const secondIndex = members[j];
          if (!forbiddenGroupTargets.has(firstIndex)) forbiddenGroupTargets.set(firstIndex, new Set<number>());
          if (!forbiddenGroupTargets.has(secondIndex)) forbiddenGroupTargets.set(secondIndex, new Set<number>());
          forbiddenGroupTargets.get(firstIndex)!.add(secondIndex);
          forbiddenGroupTargets.get(secondIndex)!.add(firstIndex);
        }
      }
    });

    const hasHardRules = settings.forbiddenPairs.length > 0
      || settings.forbiddenGroups.length > 0
      || settings.fixedSeats.length > 0
      || settings.frontOnly.length > 0
      || settings.noBackRow.length > 0
      || settings.noSoloSeat.length > 0;

    return {
      hasHardRules,
      seatIndexByKey,
      adjacencyBySeatIndex,
      pairGroupBySeatIndex,
      frontRow,
      backRow,
      allowedSeatIndicesByStudent,
      fixedSeatIndexByStudent,
      forbiddenPairTargets,
      forbiddenGroupTargets,
    };
  };

  const buildRulePenalty = (positions: Position[], compiledRules: CompiledShuffleRules) => {
    if (!compiledRules.hasHardRules) return 0;

    let violations = 0;
    const assignedSeatByStudent = positions.map((seat) => compiledRules.seatIndexByKey.get(`${seat.r},${seat.c}`));

    assignedSeatByStudent.forEach((seatIndex, studentIndex) => {
      if (seatIndex === undefined) {
        violations += 1;
        return;
      }

      const fixedSeatIndex = compiledRules.fixedSeatIndexByStudent.get(studentIndex);
      if (fixedSeatIndex !== undefined && seatIndex !== fixedSeatIndex) {
        violations += FIXED_SEAT_MISS_PENALTY;
      } else if (!compiledRules.allowedSeatIndicesByStudent[studentIndex]?.includes(seatIndex)) {
        violations += 1;
      }

      const pairTargets = compiledRules.forbiddenPairTargets.get(studentIndex);
      if (pairTargets) {
        pairTargets.forEach((otherStudentIndex) => {
          if (otherStudentIndex <= studentIndex) return;
          const otherSeatIndex = assignedSeatByStudent[otherStudentIndex];
          if (otherSeatIndex === undefined) return;
          const pairGroup = compiledRules.pairGroupBySeatIndex.get(seatIndex);
          if (pairGroup !== undefined && pairGroup === compiledRules.pairGroupBySeatIndex.get(otherSeatIndex)) {
            violations += 1;
          }
        });
      }

      const groupTargets = compiledRules.forbiddenGroupTargets.get(studentIndex);
      if (groupTargets) {
        groupTargets.forEach((otherStudentIndex) => {
          if (otherStudentIndex <= studentIndex) return;
          const otherSeatIndex = assignedSeatByStudent[otherStudentIndex];
          if (otherSeatIndex === undefined) return;
          if (compiledRules.adjacencyBySeatIndex[seatIndex]?.includes(otherSeatIndex)) {
            violations += 1;
          }
        });
      }
    });

    return violations;
  };

  const buildGenderBalancedPositions = (baseConfig: ClassroomConfig): Position[] => {
    const students = baseConfig.students;
    const seats = shuffleArray(baseConfig.positions);
    const maleCount = students.filter((student) => student.gender === 'M').length;
    const femaleCount = students.filter((student) => student.gender === 'F').length;
    if (seats.length <= 1 || maleCount + femaleCount === 0) return seats;

    const rowSeats: Position[][] = [];
    const rowMap = new Map<number, Position[]>();
    [...baseConfig.positions]
      .sort((a, b) => (a.r !== b.r ? a.r - b.r : a.c - b.c))
      .forEach((seat) => {
        const list = rowMap.get(seat.r) || [];
        list.push(seat);
        rowMap.set(seat.r, list);
      });

    [...rowMap.keys()].sort((a, b) => a - b).forEach((row) => {
      const list = (rowMap.get(row) || []).slice().sort((a, b) => a.c - b.c);
      rowSeats.push(list);
    });

    const seatTemplate: Position[] = [];
    rowSeats.forEach((list) => {
      for (let i = 0; i < list.length; i += 2) {
        const left = list[i];
        const right = list[i + 1];
        if (!right) {
          seatTemplate.push(left);
          continue;
        }
        if (Math.random() > 0.5) {
          seatTemplate.push(left, right);
        } else {
          seatTemplate.push(right, left);
        }
      }
    });

    const seatByGenderTarget: Record<'M' | 'F' | 'N', Position[]> = { M: [], F: [], N: [] };
    const totalGenderSeatCount = maleCount + femaleCount;
    const genderTargets: Array<'M' | 'F'> = [];
    let remainMale = maleCount;
    let remainFemale = femaleCount;

    while (genderTargets.length < totalGenderSeatCount) {
      const remainSlots = totalGenderSeatCount - genderTargets.length;
      if (remainSlots === 1) {
        if (remainMale > 0) genderTargets.push('M');
        else genderTargets.push('F');
        if (remainMale > 0) remainMale -= 1;
        if (remainFemale > 0) remainFemale -= 1;
        continue;
      }

      if (remainMale > 0 && remainFemale > 0) {
        if (Math.random() > 0.5) {
          genderTargets.push('M', 'F');
        } else {
          genderTargets.push('F', 'M');
        }
        remainMale -= 1;
        remainFemale -= 1;
      } else if (remainMale > 1) {
        genderTargets.push('M', 'M');
        remainMale -= 2;
      } else if (remainFemale > 1) {
        genderTargets.push('F', 'F');
        remainFemale -= 2;
      }
    }

    for (let i = genderTargets.length; i < seatTemplate.length; i += 1) {
      seatByGenderTarget.N.push(seatTemplate[i]);
    }
    genderTargets.forEach((gender, idx) => {
      const targetSeat = seatTemplate[idx];
      if (!targetSeat) return;
      seatByGenderTarget[gender].push(targetSeat);
    });

    const seatsByGender = {
      M: shuffleArray(seatByGenderTarget.M),
      F: shuffleArray(seatByGenderTarget.F),
      N: shuffleArray(seatByGenderTarget.N),
    };

    let mIndex = 0;
    let fIndex = 0;
    let nIndex = 0;
    const pool = shuffleArray([...seatTemplate]);
    const consume = (seat?: Position): Position | undefined => {
      if (!seat) return undefined;
      const poolIndex = pool.findIndex(p => p.r === seat.r && p.c === seat.c);
      if (poolIndex >= 0) pool.splice(poolIndex, 1);
      return seat;
    };

    const nextSeatByGender = (gender: Gender): Position => {
      if (gender === 'M') return consume(seatsByGender.M[mIndex++]) || consume(pool.shift())!;
      if (gender === 'F') return consume(seatsByGender.F[fIndex++]) || consume(pool.shift())!;
      return consume(seatsByGender.N[nIndex++]) || consume(pool.shift())!;
    };

    return students.map(student => nextSeatByGender(student.gender) || { r: 0, c: 0 });
  };

  const buildGenderPenalty = (positions: Position[], students: Student[]) => {
    if (positions.length !== students.length || students.length === 0) return 0;

    const seatToGender = new Map<string, Gender>();
    students.forEach((student, index) => {
      const seat = positions[index];
      if (seat) seatToGender.set(`${seat.r},${seat.c}`, student.gender);
    });

    let penalty = 0;
    const rowMap = new Map<number, Position[]>();
    positions.forEach((seat) => {
      const list = rowMap.get(seat.r) || [];
      list.push(seat);
      rowMap.set(seat.r, list);
    });

    [...rowMap.keys()].sort((a, b) => a - b).forEach((row) => {
      const list = (rowMap.get(row) || []).sort((a, b) => a.c - b.c);
      for (let i = 0; i + 1 < list.length; i += 2) {
        const leftGender = seatToGender.get(`${list[i].r},${list[i].c}`);
        const rightGender = seatToGender.get(`${list[i + 1].r},${list[i + 1].c}`);
        if (leftGender && rightGender && leftGender !== 'N' && rightGender !== 'N' && leftGender === rightGender) {
          penalty += 1;
        }
      }
    });

    return penalty;
  };

  const buildNonDuplicateShufflePositions = (
    baseConfig: ClassroomConfig,
    options: {
      avoidDuplicate: boolean;
      balanceGender: boolean;
      settings: ShuffleSettings;
      maxAttempts?: number;
    },
  ): { positions: Position[]; status: ShuffleResultStatus } => {
    const maxAttempts = options.maxAttempts || 500;
    const seen = new Set<string>();
    const shouldTrack = options.avoidDuplicate;
    const compiledRules = buildShuffleRuleState(baseConfig, options.settings);
    const searchStartedAt = getNow();
    let backtrackNodeCount = 0;
    let bestFallback: Position[] | null = null;
    let bestRulePenalty = Number.MAX_SAFE_INTEGER;
    let bestUnchangedSeatCount = Number.MAX_SAFE_INTEGER;
    let bestHistoryPenalty = Number.MAX_SAFE_INTEGER;
    let bestGenderPenalty = Number.MAX_SAFE_INTEGER;

    const isSameLayout = (a: Position[], b: Position[]) => {
      if (a.length !== b.length) return false;
      return a.every((pos, i) => pos.r === b[i].r && pos.c === b[i].c);
    };

    const countStudentsKeepingSeat = (positions: Position[]) => {
      if (!shouldTrack || positions.length !== baseConfig.positions.length) return 0;
      return positions.reduce((count, seat, studentIndex) => {
        const currentSeat = baseConfig.positions[studentIndex];
        if (currentSeat && currentSeat.r === seat.r && currentSeat.c === seat.c) {
          return count + 1;
        }
        return count;
      }, 0);
    };

    const isSearchTimedOut = () => getNow() - searchStartedAt >= SHUFFLE_SEARCH_DEADLINE_MS;
    const buildRandomPositions = () => {
      if (options.balanceGender) return buildGenderBalancedPositions(baseConfig);
      if (shouldTrack) return buildDerangedPositions(baseConfig.positions) ?? shuffleArray(baseConfig.positions);
      return shuffleArray(baseConfig.positions);
    };
    const buildFallbackPositions = () => {
      if (shouldTrack) return buildDerangedPositions(baseConfig.positions) ?? buildRandomPositions();
      return buildRandomPositions();
    };

    const isHistoryBlocked = (positions: Position[]) => {
      const shuffledSignature = createLayoutSignature({ ...baseConfig, positions });
      const shuffledPairSignatures = createPairNameSignature({ ...baseConfig, positions });
      const hasForbiddenPair = shuffledPairSignatures.some((signature) => savedPairSignatures.has(signature));
      const hasForbiddenLayout = savedLayoutSignatures.has(shuffledSignature);
      return shouldTrack && (hasForbiddenPair || hasForbiddenLayout);
    };

    const buildCandidateWithBacktracking = (
      requireHistoryClear: boolean,
      requireSeatChange: boolean,
    ): Position[] | null => {
      if (!compiledRules.hasHardRules) return null;

      const preferredSeatIndices = options.balanceGender
        ? buildGenderBalancedPositions(baseConfig).map((seat) => compiledRules.seatIndexByKey.get(`${seat.r},${seat.c}`) ?? -1)
        : [];

      if (compiledRules.allowedSeatIndicesByStudent.some((allowedSeats) => allowedSeats.length === 0)) return null;

      const studentOrder = baseConfig.students
        .map((_, studentIndex) => {
          const pairCount = compiledRules.forbiddenPairTargets.get(studentIndex)?.size || 0;
          const groupCount = compiledRules.forbiddenGroupTargets.get(studentIndex)?.size || 0;
          return {
            studentIndex,
            domainSize: compiledRules.allowedSeatIndicesByStudent[studentIndex].length,
            weight: pairCount + groupCount,
            random: Math.random(),
          };
        })
        .sort((a, b) => {
          if (a.domainSize !== b.domainSize) return a.domainSize - b.domainSize;
          if (a.weight !== b.weight) return b.weight - a.weight;
          return a.random - b.random;
        })
        .map((item) => item.studentIndex);

      const seatAssignments = Array<number | null>(baseConfig.students.length).fill(null);
      const usedSeats = new Set<number>();

      const search = (orderIndex: number): boolean => {
        if (isSearchTimedOut()) return false;
        backtrackNodeCount += 1;
        if (backtrackNodeCount > SHUFFLE_BACKTRACK_NODE_LIMIT) return false;

        if (orderIndex >= studentOrder.length) {
          const positions = seatAssignments.map((seatIndex) => baseConfig.positions[seatIndex!]);
          if (isSameLayout(positions, baseConfig.positions)) return false;
          if (requireSeatChange && countStudentsKeepingSeat(positions) > 0) return false;
          if (requireHistoryClear && isHistoryBlocked(positions)) return false;
          return true;
        }

        const studentIndex = studentOrder[orderIndex];
        const preferredSeatIndex = preferredSeatIndices[studentIndex];
        const currentSeatIndex = compiledRules.seatIndexByKey.get(createSeatKey(baseConfig.positions[studentIndex]));
        const candidates = shuffleArray(compiledRules.allowedSeatIndicesByStudent[studentIndex])
          .filter((seatIndex) => !usedSeats.has(seatIndex))
          .filter((seatIndex) => !requireSeatChange || currentSeatIndex === undefined || seatIndex !== currentSeatIndex)
          .sort((a, b) => {
            const aPreferred = a === preferredSeatIndex ? 1 : 0;
            const bPreferred = b === preferredSeatIndex ? 1 : 0;
            return bPreferred - aPreferred;
          });

        for (const seatIndex of candidates) {
          let blocked = false;

          const pairTargets = compiledRules.forbiddenPairTargets.get(studentIndex);
          if (pairTargets) {
            pairTargets.forEach((otherStudentIndex) => {
              const otherSeatIndex = seatAssignments[otherStudentIndex];
              if (otherSeatIndex === null || blocked) return;
              const pairGroup = compiledRules.pairGroupBySeatIndex.get(seatIndex);
              if (pairGroup !== undefined && pairGroup === compiledRules.pairGroupBySeatIndex.get(otherSeatIndex)) {
                blocked = true;
              }
            });
          }

          const groupTargets = compiledRules.forbiddenGroupTargets.get(studentIndex);
          if (groupTargets && !blocked) {
            groupTargets.forEach((otherStudentIndex) => {
              const otherSeatIndex = seatAssignments[otherStudentIndex];
              if (otherSeatIndex === null || blocked) return;
              if (compiledRules.adjacencyBySeatIndex[seatIndex]?.includes(otherSeatIndex)) {
                blocked = true;
              }
            });
          }

          if (blocked) continue;

          seatAssignments[studentIndex] = seatIndex;
          usedSeats.add(seatIndex);
          if (search(orderIndex + 1)) return true;
          usedSeats.delete(seatIndex);
          seatAssignments[studentIndex] = null;
        }

        return false;
      };

      return search(0) ? seatAssignments.map((seatIndex) => baseConfig.positions[seatIndex!]) : null;
    };

    if (compiledRules.hasHardRules) {
      const strictAttempts = Math.max(40, Math.floor(maxAttempts / 8));
      for (let attempt = 0; attempt < strictAttempts; attempt += 1) {
        if (isSearchTimedOut()) break;
        const positions = buildCandidateWithBacktracking(shouldTrack, shouldTrack);
        if (positions) return { positions, status: 'all' };
      }

      if (shouldTrack) {
        for (let attempt = 0; attempt < strictAttempts; attempt += 1) {
          if (isSearchTimedOut()) break;
          const positions = buildCandidateWithBacktracking(false, true);
          if (positions) return { positions, status: 'history_relaxed' };
        }
      }
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (isSearchTimedOut()) break;
      const shuffled = buildRandomPositions();

      if (shouldTrack && seen.has(createLayoutSignature({ ...baseConfig, positions: shuffled }))) continue;
      if (isSameLayout(shuffled, baseConfig.positions)) continue;

      const shuffledSignature = createLayoutSignature({ ...baseConfig, positions: shuffled });
      if (shouldTrack) seen.add(shuffledSignature);
      const unchangedSeatCount = countStudentsKeepingSeat(shuffled);
      const blockedByHistory = isHistoryBlocked(shuffled);
      const historyPenalty = blockedByHistory ? 1 : 0;
      const currentRulePenalty = buildRulePenalty(shuffled, compiledRules);
      const genderPenalty = options.balanceGender ? buildGenderPenalty(shuffled, baseConfig.students) : 0;

      if (currentRulePenalty === 0 && unchangedSeatCount === 0 && !blockedByHistory) {
        return { positions: shuffled, status: 'all' };
      }

      if (bestFallback === null || currentRulePenalty < bestRulePenalty || (
        currentRulePenalty === bestRulePenalty && unchangedSeatCount < bestUnchangedSeatCount
      ) || (
        currentRulePenalty === bestRulePenalty && unchangedSeatCount === bestUnchangedSeatCount && historyPenalty < bestHistoryPenalty
      ) || (
        currentRulePenalty === bestRulePenalty && unchangedSeatCount === bestUnchangedSeatCount && historyPenalty === bestHistoryPenalty && genderPenalty < bestGenderPenalty
      )) {
        bestFallback = shuffled;
        bestRulePenalty = currentRulePenalty;
        bestUnchangedSeatCount = unchangedSeatCount;
        bestHistoryPenalty = historyPenalty;
        bestGenderPenalty = genderPenalty;
      }
    }

    return {
      positions: bestFallback ?? buildFallbackPositions(),
      status: bestRulePenalty === 0 && bestUnchangedSeatCount === 0 ? 'history_relaxed' : 'rules_relaxed',
    };
  };
  
  const [displayStudents, setDisplayStudents] = useState<Student[]>(config.students);
  const countdownTimerRef = useRef<number | null>(null);
  const countdownPollTimerRef = useRef<number | null>(null);
  const countdownEndTimeRef = useRef<number | null>(null);
  const shuffleStartLockRef = useRef(false);
  const shuffleIntervalRef = useRef<number | null>(null);
  const movementIntervalRef = useRef<number | null>(null);
  const shufflePreparationTimerRef = useRef<number | null>(null);
  const shufflePreparationPromiseRef = useRef<Promise<PreparedShuffleResult> | null>(null);
  const preparedShuffleResultRef = useRef<PreparedShuffleResult | null>(null);
  const shufflePreparationTokenRef = useRef(0);
  const layoutContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    localStorage.setItem('classroom_shuffle_settings_v3', JSON.stringify(shuffleSettings));
  }, [shuffleSettings]);

  useEffect(() => {
    setShuffleSettings((prev) => {
      const next = sanitizeShuffleSettings(prev, config.students, config.positions);
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
    });
  }, [config.students, config.positions]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
      if (e instanceof Error && e.name === 'QuotaExceededError') {
        alert("브라우저 저장 용량이 가득 찼습니다. 기록실에서 불필요한 배치를 삭제해 주세요.");
      }
    }
  }, [history]);

  useEffect(() => {
    if (!isShuffling && countdown === null) {
      setDisplayStudents(config.students);
      setShufflingOffsets({});
    }
  }, [config.students, isShuffling, countdown]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(pointer: coarse)');
    const updatePointerType = () => setIsCoarsePointerDevice(mediaQuery.matches);
    updatePointerType();
    mediaQuery.addEventListener('change', updatePointerType);
    return () => mediaQuery.removeEventListener('change', updatePointerType);
  }, []);

  // 편집 모드가 바뀌면 선택된 좌석 초기화
  useEffect(() => {
    setSelectedSeat(null);
    setSelectedPairSeat(null);
  }, [editMode]);

  const stopAllTimers = () => {
    if (countdownTimerRef.current !== null) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    if (countdownPollTimerRef.current !== null) {
      clearInterval(countdownPollTimerRef.current);
      countdownPollTimerRef.current = null;
    }
    if (shuffleIntervalRef.current !== null) {
      clearInterval(shuffleIntervalRef.current);
      shuffleIntervalRef.current = null;
    }
    if (movementIntervalRef.current !== null) {
      clearInterval(movementIntervalRef.current);
      movementIntervalRef.current = null;
    }
    if (shufflePreparationTimerRef.current !== null) {
      clearTimeout(shufflePreparationTimerRef.current);
      shufflePreparationTimerRef.current = null;
    }
    countdownEndTimeRef.current = null;
    shufflePreparationPromiseRef.current = null;
    preparedShuffleResultRef.current = null;
  };

  const stopCountdownTimers = () => {
    if (countdownTimerRef.current !== null) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    if (countdownPollTimerRef.current !== null) {
      clearInterval(countdownPollTimerRef.current);
      countdownPollTimerRef.current = null;
    }
    countdownEndTimeRef.current = null;
  };

  const handleShuffleStart = useCallback(() => {
    if (shuffleStartLockRef.current || isShuffling || countdown !== null) return;
    shuffleStartLockRef.current = true;
    shufflePreparationTokenRef.current += 1;
    
    stopAllTimers();
    setIsShuffling(true);
    setCountdown(5);
    setShowCelebration(false);
    
    // 첫 클릭 시 오디오 컨텍스트 활성화 시도 (모바일 대응)
    try {
      audioService.playCountdownTick();
    } catch (e) {
      console.warn("Audio play failed:", e);
    }
    
    const currentStudents = config.students;
    const currentPositions = config.positions;
    const isCoarsePointer = isCoarsePointerDevice;
    const currentPreparationToken = shufflePreparationTokenRef.current;
    countdownEndTimeRef.current = Date.now() + 5000;
    let hasFinalized = false;

    const computeShuffleResult = (): PreparedShuffleResult => buildNonDuplicateShufflePositions({
      ...config,
      positions: currentPositions,
    }, {
      avoidDuplicate: shuffleSettings.avoidDuplicate,
      balanceGender: shuffleSettings.genderBalance,
      settings: shuffleSettings,
    });

    const scheduleShufflePreparation = () => {
      if (shufflePreparationTimerRef.current !== null) {
        clearTimeout(shufflePreparationTimerRef.current);
      }

      shufflePreparationTimerRef.current = window.setTimeout(() => {
        shufflePreparationTimerRef.current = null;
        if (shufflePreparationTokenRef.current !== currentPreparationToken) return;

        const preparationPromise = new Promise<PreparedShuffleResult>((resolve) => {
          window.setTimeout(() => {
            const result = computeShuffleResult();
            if (shufflePreparationTokenRef.current === currentPreparationToken) {
              preparedShuffleResultRef.current = result;
            }
            resolve(result);
          }, 0);
        });

        shufflePreparationPromiseRef.current = preparationPromise;
      }, isCoarsePointer ? 420 : 260);
    };

    const finalizeShuffle = async () => {
      if (hasFinalized) return;
      hasFinalized = true;
      stopCountdownTimers();

      let result = preparedShuffleResultRef.current;
      if (!result) {
        if (shufflePreparationPromiseRef.current === null) {
          shufflePreparationPromiseRef.current = new Promise<PreparedShuffleResult>((resolve) => {
            window.setTimeout(() => {
              const computedResult = computeShuffleResult();
              if (shufflePreparationTokenRef.current === currentPreparationToken) {
                preparedShuffleResultRef.current = computedResult;
              }
              resolve(computedResult);
            }, 0);
          });
        }

        result = await shufflePreparationPromiseRef.current;
      }

      if (shufflePreparationTokenRef.current !== currentPreparationToken) return;

      shuffleStartLockRef.current = false;
      stopAllTimers();
      const { positions: shuffledPositions, status } = result;
      if (status === 'history_relaxed') {
        alert('학생 자리는 모두 바뀌었지만 저장된 기록까지 모두 피하는 배치를 찾지 못해 기록 중복을 허용한 배치로 적용했어요.');
      }
      if (status === 'rules_relaxed') {
        alert('현재 자리 구조와 설정으로는 모든 학생의 자리를 바꾸면서 규칙까지 함께 만족하는 배치를 찾지 못해 가장 가까운 배치로 적용했어요.');
      }
      setConfig(prevConfig => ({ ...prevConfig, positions: shuffledPositions }));
      setIsShuffling(false);
      setCountdown(null);
      setShufflingOffsets({});
      setDisplayStudents(currentStudents);
      setShowCelebration(true);
      try {
        audioService.playSuccess();
      } catch(e) {}
      setTimeout(() => setShowCelebration(false), 2500);
    };

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (shufflePreparationTokenRef.current !== currentPreparationToken) return;
        scheduleShufflePreparation();
      });
    });

    countdownTimerRef.current = window.setInterval(() => {
      setCountdown(prev => {
        if (prev === null) return null;
        if (prev <= 1) {
          void finalizeShuffle();
          return null;
        }
        
        try {
          audioService.playCountdownTick();
        } catch (e) {
          // 오디오 실패해도 카운트다운은 계속됨
        }
        return prev - 1;
      });
    }, 1000);

    countdownPollTimerRef.current = window.setInterval(() => {
      const endTime = countdownEndTimeRef.current;
      if (endTime === null) return;
      const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));

      if (remaining <= 0) {
        void finalizeShuffle();
        return;
      }
      setCountdown(prev => (prev === null || prev === remaining ? prev : remaining));
    }, 250);

    // 모바일 성능을 위해 업데이트 주기를 150ms -> 200ms로 조정
    shuffleIntervalRef.current = window.setInterval(() => {
      setDisplayStudents(prev => shuffleArray(prev));
      try {
        if (!isCoarsePointer || Math.random() > 0.5) {
          audioService.playShuffleTick();
        }
      } catch(e) {}
    }, isCoarsePointer ? 320 : 200);

    movementIntervalRef.current = window.setInterval(() => {
      const newOffsets: Record<string, { x: number, y: number }> = {};
      currentPositions.forEach((pos) => {
        newOffsets[`${pos.r},${pos.c}`] = { x: (Math.random() - 0.5) * 40, y: (Math.random() - 0.5) * 40 };
      });
      setShufflingOffsets(newOffsets);
    }, isCoarsePointer ? 520 : 400);
  }, [config.students, config.positions, isShuffling, countdown, isCoarsePointerDevice, savedLayoutSignatures, savedPairSignatures, shuffleSettings]);

  useEffect(() => {
    return () => {
      stopAllTimers();
    };
  }, []);

  const getDefaultRecordTitle = useCallback(() => {
    return `${new Date().getMonth() + 1}월 ${new Date().getDate()}일 자리 배치`;
  }, []);

  const sanitizeFileName = useCallback((value: string) => {
    const normalized = value
      .trim()
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ');
    return normalized || getDefaultRecordTitle();
  }, [getDefaultRecordTitle]);

  const captureLayoutImage = useCallback(async (title: string) => {
    if (!layoutContainerRef.current || isCapturing) return;

    const layoutRoot = layoutContainerRef.current;
    const targetElement =
      (layoutRoot.querySelector('.capture-target') as HTMLElement | null) ??
      (layoutRoot.querySelector('.layout-content') as HTMLElement | null) ??
      layoutRoot;
    if (!targetElement) return;

    const isMobileCapture = isCoarsePointerDevice || window.innerWidth < 1024;
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const fileName = `${sanitizeFileName(title)}.jpg`;
    const desktopPaddingX = 56;
    const desktopPaddingY = 34;

    try {
      setIsCapturing(true);
      audioService.playCapture();
      if ('fonts' in document && document.fonts?.ready) {
        try {
          const fontsReadyTask = document.fonts.ready;
          const fontsTimeoutTask = new Promise<void>((resolve) => {
            window.setTimeout(resolve, isMobileCapture ? 1800 : 3000);
          });
          await Promise.race([fontsReadyTask, fontsTimeoutTask]);
        } catch {
        }
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const rect = targetElement.getBoundingClientRect();
      const width = Math.max(1, Math.ceil(Math.max(rect.width, targetElement.scrollWidth || 0, targetElement.clientWidth || 0)));
      const height = Math.max(1, Math.ceil(Math.max(rect.height, targetElement.scrollHeight || 0, targetElement.clientHeight || 0)));
      const pixelRatio = isMobileCapture
        ? Math.min(1.25, window.devicePixelRatio || 1)
        : Math.min(2, window.devicePixelRatio || 1.5);

      const baseOptions = {
        backgroundColor: '#fdfbf7',
        pixelRatio,
        width,
        height,
        cacheBust: !isMobileCapture,
        skipAutoScale: false,
        style: {
          animation: 'none',
          transition: 'none',
          margin: '0',
          padding: '0',
        },
      };

      let baseCanvas: HTMLCanvasElement;
      try {
        baseCanvas = await htmlToImage.toCanvas(targetElement, {
          ...baseOptions,
          skipFonts: false,
        });
      } catch {
        baseCanvas = await htmlToImage.toCanvas(targetElement, {
          ...baseOptions,
          skipFonts: true,
          width: undefined,
          height: undefined,
        });
      }

      let exportCanvas = baseCanvas;
      if (!isMobileCapture) {
        const paddedCanvas = document.createElement('canvas');
        paddedCanvas.width = baseCanvas.width + desktopPaddingX * 2 * pixelRatio;
        paddedCanvas.height = baseCanvas.height + desktopPaddingY * 2 * pixelRatio;
        const ctx = paddedCanvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#fdfbf7';
          ctx.fillRect(0, 0, paddedCanvas.width, paddedCanvas.height);
          ctx.drawImage(baseCanvas, desktopPaddingX * pixelRatio, desktopPaddingY * pixelRatio);
          exportCanvas = paddedCanvas;
        }
      }

      const quality = isMobileCapture ? 0.82 : 0.9;
      const blob = await new Promise<Blob | null>((resolve) => {
        exportCanvas.toBlob(resolve, 'image/jpeg', quality);
      });

      if (!blob) {
        const fallbackDataUrl = exportCanvas.toDataURL('image/jpeg', quality);
        setExpandedImage(fallbackDataUrl);
        return;
      }

      const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
      if (isMobileCapture && nav.share) {
        const file = new File([blob], fileName, { type: 'image/jpeg' });
        if (!nav.canShare || nav.canShare({ files: [file] })) {
          try {
            await nav.share({ files: [file], title: '자리 배치 캡쳐' });
            return;
          } catch (shareError) {
            if (shareError instanceof DOMException && shareError.name === 'AbortError') return;
            console.warn('Share failed, falling back to local preview/download.', shareError);
          }
        }
      }

      if (isMobileCapture && isIOS) {
        const fallbackDataUrl = exportCanvas.toDataURL('image/jpeg', quality);
        setExpandedImage(fallbackDataUrl);
        alert('iPhone Safari에서는 이미지 길게 누른 뒤 "사진 앱에 저장"을 선택해 주세요.');
        return;
      }

      const link = document.createElement('a');
      const objectUrl = URL.createObjectURL(blob);
      link.href = objectUrl;
      link.download = fileName;
      link.rel = 'noopener';
      if (isMobileCapture) link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error(err);
      alert('이미지 캡처에 실패했습니다. 다시 시도해 주세요.');
    } finally {
      setIsCapturing(false);
    }
  }, [getDefaultRecordTitle, isCapturing, isCoarsePointerDevice, sanitizeFileName]);

  const openSaveModal = (action: SaveModalAction) => {
    setSaveModalAction(action);
    setNewRecordTitle(getDefaultRecordTitle());
    setIsSaveModalOpen(true);
    audioService.playClick();
  };

  const handleCapture = () => {
    openSaveModal('capture');
  };

  const triggerSaveModal = () => {
    openSaveModal('history');
  };

  const handleSaveToHistory = async () => {
    setIsSaveModalOpen(false);
    const contentElement =
      (layoutContainerRef.current?.querySelector('.capture-target') as HTMLElement | null) ??
      (layoutContainerRef.current?.querySelector('.layout-content') as HTMLElement | null);
    
    if (!contentElement) return;

    const baseHistoryItem: Omit<HistoryItem, 'id' | 'date' | 'thumbnail'> = {
      title: newRecordTitle.trim() || `${new Date().toLocaleDateString()} 배치`,
      config: JSON.parse(JSON.stringify(config)),
      studentSnapshots: createStudentSnapshots(config),
    };

    try {
      audioService.playSave();
      
      const thumbnail = await htmlToImage.toPng(contentElement, {
        backgroundColor: '#fdfbf7',
        pixelRatio: 2.0, 
        cacheBust: true,
        style: {
          transform: 'none',
          margin: '0',
          padding: '40px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center'
        }
      });

      const newItem: HistoryItem = {
        id: crypto.randomUUID(),
        date: new Date().toLocaleString(),
        ...baseHistoryItem,
        thumbnail,
      };
      setHistory(prev => [newItem, ...prev]);
      setNewRecordTitle('');
    } catch (e) {
      console.error("Save failed:", e);
      const newItem: HistoryItem = { 
        id: crypto.randomUUID(), 
        date: new Date().toLocaleString(), 
        ...baseHistoryItem, 
      };
      setHistory(prev => [newItem, ...prev]);
      alert('이미지 생성에 실패하여 텍스트 데이터만 저장되었습니다.');
    }
  };

  const handleSaveModalConfirm = async () => {
    if (!newRecordTitle.trim()) return;
    if (saveModalAction === 'capture') {
      const captureTitle = newRecordTitle.trim();
      setIsSaveModalOpen(false);
      await captureLayoutImage(captureTitle);
      return;
    }
    await handleSaveToHistory();
  };

  const handleConfirmAction = () => {
    if (!confirmAction) return;
    const { type, item } = confirmAction;
    
    if (type === 'delete') {
      setHistory(prev => prev.filter(i => i.id !== item.id));
      audioService.playClick();
    } else {
      const restoredConfig = normalizeConfig(item.config);
      setConfig(restoredConfig);
      setDisplayStudents(restoredConfig.students);
      setIsHistoryOpen(false);
      audioService.playSuccess();
    }
    setConfirmAction(null);
  };

  const handleSeatInteraction = (r: number, c: number) => {
    if (editMode === 'group') {
        audioService.playClick();
        const key = `${r},${c}`;
        setConfig(prev => {
          const newGroupMap = { ...prev.groupMap };
          if (selectedGroupId === 0) delete newGroupMap[key];
          else newGroupMap[key] = selectedGroupId;
          return { ...prev, groupMap: newGroupMap };
        });
    } else if (editMode === 'pair') {
        const key = `${r},${c}`;

        if (config.pairMap[key] !== undefined) {
          setConfig(prev => {
            const newPairMap = { ...prev.pairMap };
            const pairId = newPairMap[key];
            if (pairId !== undefined) {
              Object.keys(newPairMap).forEach((k) => {
                if (newPairMap[k] === pairId) delete newPairMap[k];
              });
            }
            return { ...prev, pairMap: newPairMap };
          });
          setSelectedPairSeat(null);
          audioService.playClick();
          return;
        }

        if (!selectedPairSeat) {
          setSelectedPairSeat({ r, c });
          audioService.playClick();
          return;
        }

        if (selectedPairSeat.r === r && selectedPairSeat.c === c) {
          setSelectedPairSeat(null);
          audioService.playClick();
          return;
        }

        if (Math.abs(selectedPairSeat.r - r) + Math.abs(selectedPairSeat.c - c) !== 1) {
          alert('짝은 좌우 또는 상하로만 지정할 수 있어요.');
          return;
        }

        const fromKey = `${selectedPairSeat.r},${selectedPairSeat.c}`;
        const toKey = key;

        setConfig(prev => {
          const newPairMap = { ...prev.pairMap };

          const clearPair = (target: string, map: Record<string, number>) => {
            const pairId = map[target];
            if (pairId === undefined) return;
            Object.keys(map).forEach((k) => {
              if (map[k] === pairId) delete map[k];
            });
          };

          clearPair(fromKey, newPairMap);
          clearPair(toKey, newPairMap);

          const pairValues = Object.values(newPairMap);
          const nextPairId = pairValues.length > 0 ? Math.max(...pairValues) + 1 : 1;

          newPairMap[fromKey] = nextPairId;
          newPairMap[toKey] = nextPairId;
          return { ...prev, pairMap: newPairMap };
        });

        setSelectedPairSeat(null);
        audioService.playClick();
    } else if (editMode === 'position') {
        // Touch & Drop Logic
        if (selectedSeat) {
            // 이미 선택된 좌석이 있을 때
            if (selectedSeat.r === r && selectedSeat.c === c) {
                // 같은 좌석을 다시 누르면 선택 취소
                setSelectedSeat(null);
                audioService.playClick();
            } else {
                // 다른 좌석을 누르면 교환(이동)
                handleSeatMove(selectedSeat, { r, c });
                setSelectedSeat(null);
                audioService.playClick(); // 이동 완료 소리
            }
        } else {
            // 선택된 좌석이 없을 때 새로 선택
            setSelectedSeat({ r, c });
            audioService.playClick();
        }
    }
  };

  const handleSeatMove = (from: {r: number, c: number}, to: {r: number, c: number}) => {
    setConfig(prev => {
      const newPositions = [...prev.positions];
      const fromIdx = newPositions.findIndex(p => p.r === from.r && p.c === from.c);
      const toIdx = newPositions.findIndex(p => p.r === to.r && p.c === to.c);
      if (fromIdx === -1) return prev;

      if (toIdx !== -1) {
        newPositions[fromIdx] = { r: to.r, c: to.c };
        newPositions[toIdx] = { r: from.r, c: from.c };
      } else {
        newPositions[fromIdx] = { r: to.r, c: to.c };
      }

      // 모둠 속성 이동
      const newGroupMap = { ...prev.groupMap };
      const newPairMap = { ...prev.pairMap };
      const fromKey = `${from.r},${from.c}`;
      const toKey = `${to.r},${to.c}`;

      const fromGroup = newGroupMap[fromKey];
      const toGroup = newGroupMap[toKey];

      if (fromGroup !== undefined) {
        newGroupMap[toKey] = fromGroup;
      } else {
        delete newGroupMap[toKey];
      }

      if (toGroup !== undefined) {
        newGroupMap[fromKey] = toGroup;
      } else {
        delete newGroupMap[fromKey];
      }

      const fromPair = newPairMap[fromKey];
      const toPair = newPairMap[toKey];

      if (fromPair !== undefined) {
        newPairMap[toKey] = fromPair;
      } else {
        delete newPairMap[toKey];
      }

      if (toPair !== undefined) {
        newPairMap[fromKey] = toPair;
      } else {
        delete newPairMap[fromKey];
      }

      return { ...prev, positions: newPositions, groupMap: newGroupMap, pairMap: newPairMap };
    });
  };

  const handleEnterSettings = () => {
    audioService.playClick();
    if (view !== 'settings-students' && view !== 'settings-shuffle') {
      setEditingStudents(JSON.parse(JSON.stringify(config.students)));
    }
    setView('settings-students');
    setEditMode('none');
  };

  const handleEnterShuffleSettings = () => {
    audioService.playClick();
    if (view !== 'settings-students' && view !== 'settings-shuffle') {
      setEditingStudents(JSON.parse(JSON.stringify(config.students)));
    }
    setView('settings-shuffle');
    setEditMode('none');
  };

  const handleSettingsTabClick = () => {
    if (view === 'settings-shuffle') {
      resetHiddenShuffleUnlock();
      handleEnterSettings();
      return;
    }

    const nextTapCount = hiddenShuffleUnlockTapCountRef.current + 1;
    hiddenShuffleUnlockTapCountRef.current = nextTapCount;

    if (nextTapCount >= SECRET_SHUFFLE_UNLOCK_TAPS) {
      resetHiddenShuffleUnlock();
      handleEnterShuffleSettings();
      return;
    }

    audioService.playClick();

    if (hiddenShuffleUnlockTimerRef.current !== null) {
      window.clearTimeout(hiddenShuffleUnlockTimerRef.current);
    }

    hiddenShuffleUnlockTimerRef.current = window.setTimeout(() => {
      hiddenShuffleUnlockTapCountRef.current = 0;
      hiddenShuffleUnlockTimerRef.current = null;
    }, SECRET_SHUFFLE_UNLOCK_WINDOW_MS);
  };

  const handleExitSettings = () => {
    setEditMode('none');
    setView('layout');
  };

  const handleSaveAndExitSettings = () => {
    audioService.playSave();
    handleUpdateConfig(editingStudents);
    handleExitSettings();
  };

  const handleResetAllSettings = () => {
    setIsResetSettingsConfirmOpen(false);
    audioService.playClick();
    setEditingStudents(DEFAULT_STUDENTS.map(student => ({ ...student, id: createStudentId() })));
    setShuffleSettings({ ...DEFAULT_SHUFFLE_SETTINGS });
  };

  const handleRequestResetAllSettings = () => {
    setIsResetSettingsConfirmOpen(true);
  };

  const handleUpdateConfig = (newStudents: Student[]) => {
    const normalizedStudents = normalizeStudents(newStudents);
    setConfig(prev => {
      const cols = 6;
      const positions = normalizedStudents.length === prev.students.length 
        ? prev.positions 
        : normalizedStudents.map((_, i) => ({ r: Math.floor(i / cols), c: i % cols }));
      
      const groupMap = normalizedStudents.length === prev.students.length ? prev.groupMap : {};
      const pairMap = normalizedStudents.length === prev.students.length ? prev.pairMap : {};

      return { students: normalizedStudents, positions, groupMap, pairMap };
    });
  };

  const bounds = useMemo(() => {
    if (config.positions.length === 0) return { minR: 0, maxR: 0, minC: 0, maxC: 0 };
    const rs = config.positions.map(p => p.r);
    const cs = config.positions.map(p => p.c);
    return { minR: 0, maxR: Math.max(...rs), minC: Math.min(...cs), maxC: Math.max(...cs) };
  }, [config.positions]);

  const visibleRange = useMemo(() => {
    return {
      startR: 0,
      endR: bounds.maxR + (editMode === 'position' ? 1 : 0),
      startC: bounds.minC - (editMode === 'position' ? 1 : 0),
      endC: bounds.maxC + (editMode === 'position' ? 1 : 0)
    };
  }, [bounds, editMode]);

  const seats: Seat[] = useMemo(() => {
    const result: Seat[] = [];
    for (let r = visibleRange.startR; r <= visibleRange.endR; r++) {
      for (let c = visibleRange.startC; c <= visibleRange.endC; c++) {
        const studentIdx = config.positions.findIndex(p => p.r === r && p.c === c);
        const isActive = studentIdx !== -1;
        result.push({
          r,
          c,
          isActive,
          student: isActive ? displayStudents[studentIdx] : null,
          groupId: config.groupMap[`${r},${c}`] || 0,
          pairId: config.pairMap[`${r},${c}`] || 0
        });
      }
    }
    return result;
  }, [visibleRange, config.positions, displayStudents, config.groupMap, config.pairMap]);

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-[#fdfbf7] text-stone-800 relative overflow-hidden font-['Noto_Sans_KR']">
      
      {/* 제목 입력 모달 */}
      {isSaveModalOpen && (
        <div className="fixed inset-0 z-[300] bg-stone-900/60 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in zoom-in duration-300">
          <div className="bg-white w-full max-w-md rounded-[2rem] shadow-2xl p-6 md:p-8 flex flex-col gap-6 border-4 border-stone-100 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-2 bg-amber-400"></div>
            <div className="flex flex-col items-center text-center gap-2 mt-2">
              <div className="bg-amber-50 p-4 rounded-full text-amber-500 mb-1">
                <Type size={32} />
              </div>
              <h3 className="text-2xl font-black text-stone-800 font-jua">기록 제목 짓기</h3>
              <p className="text-stone-500 font-medium text-sm">
                {saveModalAction === 'capture'
                  ? '이미지 파일 이름으로 사용할 제목을 입력해 주세요.'
                  : '나중에 기억하기 쉬운 멋진 이름을 지어주세요!'}
              </p>
            </div>
            
            <div className="relative">
              <input 
                autoFocus
                type="text"
                maxLength={30}
                value={newRecordTitle}
                onChange={e => setNewRecordTitle(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSaveModalConfirm()}
                placeholder="예: 우리반 3월 첫 짝궁"
                className="w-full bg-stone-50 border-2 border-stone-200 rounded-xl px-5 py-4 text-xl font-bold outline-none focus:border-amber-400 focus:bg-white focus:ring-4 focus:ring-amber-50 transition-all text-stone-700 font-jua placeholder:text-stone-300 placeholder:font-sans"
              />
              <span className="absolute right-4 bottom-2 text-[10px] font-bold text-stone-300">
                {newRecordTitle.length}/30
              </span>
            </div>

            <div className="flex gap-3">
              <button 
                onClick={() => setIsSaveModalOpen(false)}
                className="flex-1 py-3.5 rounded-xl font-black text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition-all font-jua text-lg"
              >
                취소
              </button>
              <button 
                onClick={handleSaveModalConfirm}
                disabled={!newRecordTitle.trim()}
                className="flex-1 py-3.5 rounded-xl font-black text-white bg-amber-500 shadow-[0_4px_0_#b45309] hover:translate-y-[2px] hover:shadow-[0_2px_0_#b45309] active:translate-y-[4px] active:shadow-none transition-all disabled:bg-stone-200 disabled:shadow-none font-jua text-lg"
              >
                {saveModalAction === 'capture' ? '이미지 저장' : '저장하기'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 확인 모달 */}
      {confirmAction && (
        <div className="fixed inset-0 z-[250] bg-black/50 backdrop-blur-sm flex items-center justify-center animate-in fade-in duration-200">
          <div className="bg-white p-6 md:p-8 rounded-[2rem] shadow-2xl max-w-sm w-full mx-4 flex flex-col items-center text-center border-4 border-stone-100">
            <div className={`p-4 rounded-full mb-4 ring-4 ${confirmAction.type === 'delete' ? 'bg-rose-100 text-rose-500 ring-rose-50' : 'bg-amber-100 text-amber-500 ring-amber-50'}`}>
              {confirmAction.type === 'delete' ? <Trash2 size={32} /> : <Play size={32} />}
            </div>
            <h3 className="text-2xl font-black text-stone-800 mb-2 font-jua">
              {confirmAction.type === 'delete' ? '정말 삭제할까요?' : '이 배치로 되돌릴까요?'}
            </h3>
            <p className="text-stone-500 font-medium mb-8 text-sm leading-relaxed">
              {confirmAction.type === 'delete' 
                ? '삭제하면 소중한 기록이 사라져서\n다시 볼 수 없어요.' 
                : '현재 배치된 자리는 사라지고\n선택한 기록으로 바뀝니다.'}
            </p>
            <div className="flex w-full gap-3">
              <button 
                onClick={() => setConfirmAction(null)} 
                className="flex-1 py-3.5 rounded-xl font-bold text-stone-400 hover:bg-stone-100 transition-colors font-jua text-lg"
              >
                취소
              </button>
              <button 
                onClick={handleConfirmAction} 
                className={`flex-1 py-3.5 rounded-xl font-bold shadow-md transition-all active:scale-95 font-jua text-lg ${confirmAction.type === 'delete' ? 'bg-rose-500 text-white hover:bg-rose-600 shadow-rose-200' : 'bg-amber-400 text-amber-950 hover:bg-amber-500 shadow-amber-200'}`}
              >
                {confirmAction.type === 'delete' ? '삭제하기' : '복구하기'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 이미지 확대 모달 */}
      {expandedImage && (
        <div 
          className="fixed inset-0 z-[400] bg-stone-900/95 backdrop-blur-md flex items-center justify-center animate-in fade-in duration-200"
          onClick={() => setExpandedImage(null)}
        >
          <button 
            className="absolute top-6 right-6 text-white/50 hover:text-white transition-colors p-2 z-[410] rounded-full hover:bg-white/10"
            onClick={() => setExpandedImage(null)}
          >
            <X className="w-8 h-8 md:w-12 md:h-12" />
          </button>
          
          <div className="relative max-w-[95vw] max-h-[90vh] flex items-center justify-center pointer-events-auto" onClick={e => e.stopPropagation()}>
             <img 
               src={expandedImage} 
               alt="Expanded Seating" 
               className="max-w-full max-h-[85vh] object-contain rounded-xl shadow-2xl bg-white p-2" 
             />
          </div>
        </div>
      )}

      {/* 기록실 모달 */}
      {isHistoryOpen && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-stone-900/80 backdrop-blur-xl animate-in fade-in duration-500 px-4 py-8">
          <div className="bg-[#fdfbf7] w-full max-w-6xl rounded-[2.5rem] shadow-2xl flex flex-col overflow-hidden h-full max-h-[90vh] border-8 border-white">
            <div className="px-6 md:px-10 py-6 border-b border-stone-200 flex items-center justify-between bg-white/50 relative z-50">
              <div className="flex items-center gap-3 md:gap-5">
                <div className="bg-amber-500 p-3.5 rounded-2xl shadow-lg shadow-amber-200 text-white transform -rotate-6">
                  <History className="w-6 h-6 md:w-7 md:h-7" strokeWidth={2.5} />
                </div>
                <div>
                  <h2 className="text-2xl md:text-3xl font-black text-stone-800 tracking-tight font-jua">추억 저장소</h2>
                  <p className="text-stone-500 font-medium text-xs md:text-sm">우리 반의 지난 자리 배치 기록들이에요.</p>
                </div>
              </div>
              <button 
                onClick={() => { audioService.playClick(); setIsHistoryOpen(false); }} 
                className="p-3 hover:bg-stone-100 rounded-full transition-all group border-2 border-stone-100 hover:border-stone-200"
              >
                <X className="text-stone-400 group-hover:text-stone-600 w-6 h-6 md:w-7 md:h-7" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto px-6 md:px-10 py-10 custom-scrollbar bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:20px_20px]">
              {history.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full opacity-30 gap-6">
                  <Smile className="text-stone-400 w-20 h-20 md:w-[100px] md:h-[100px]" />
                  <p className="text-xl md:text-2xl font-bold font-jua text-stone-400">아직 저장된 추억이 없어요.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                  {history.map((item) => (
                    <div key={item.id} className="group bg-white rounded-[2rem] overflow-hidden hover:shadow-[0_20px_40px_-15px_rgba(0,0,0,0.1)] transition-all duration-300 flex flex-col border-2 border-stone-100 hover:border-amber-200 hover:-translate-y-1">
                      {/* ... History Item Content ... */}
                      <div 
                        className="aspect-[16/10] bg-stone-50 relative overflow-hidden border-b-2 border-stone-100 cursor-zoom-in group/image"
                        onClick={() => setExpandedImage(item.thumbnail || null)}
                      >
                        {item.thumbnail ? (
                          <div className="w-full h-full p-6 flex items-center justify-center">
                             <img 
                               src={item.thumbnail} 
                               alt="History Seating" 
                               className="max-w-full max-h-full object-contain drop-shadow-sm transition-transform duration-500 group-hover/image:scale-105" 
                             />
                          </div>
                        ) : (
                          <div className="flex flex-col items-center justify-center h-full gap-3 text-stone-300">
                             <Camera size={48} />
                             <span className="font-bold font-jua">이미지 없음</span>
                          </div>
                        )}
                        <div className="absolute inset-0 bg-amber-900/0 group-hover/image:bg-amber-900/5 transition-colors flex items-center justify-center pointer-events-none">
                            <div className="bg-white/90 p-3 rounded-full shadow-lg opacity-0 group-hover/image:opacity-100 transform scale-75 group-hover/image:scale-100 transition-all duration-300">
                                <Maximize2 size={20} className="text-amber-600" />
                            </div>
                        </div>
                      </div>
                      
                      <div className="px-6 py-5 flex flex-col gap-4 bg-white mt-auto relative z-10">
                        <div className="flex flex-col gap-1 overflow-hidden">
                          <h4 className="font-black text-stone-800 text-xl truncate font-jua" title={item.title}>{item.title || item.date}</h4>
                          <div className="flex items-center gap-2 text-xs font-bold text-stone-400">
                            <span>{item.date.split('.')[1]}월 {item.date.split('.')[2]}일</span>
                            <span className="w-1 h-1 bg-stone-300 rounded-full"></span>
                            <span>{item.config.students.length}명</span>
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-2">
                           <button 
                             onClick={(e) => { e.stopPropagation(); setConfirmAction({ type: 'restore', item }); }} 
                             className="flex-1 py-2.5 bg-amber-50 text-amber-600 rounded-xl font-black text-sm hover:bg-amber-100 active:scale-95 transition-all flex items-center justify-center gap-1.5"
                           >
                             <Play size={14} fill="currentColor" />
                             복구
                           </button>
                           <button 
                             onClick={(e) => { e.stopPropagation(); setConfirmAction({ type: 'delete', item }); }} 
                             className="p-2.5 bg-rose-50 text-rose-500 rounded-xl hover:bg-rose-100 active:scale-95 transition-all"
                             title="삭제"
                           >
                             <Trash2 size={18} />
                           </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 카운트다운 오버레이 */}
      {countdown !== null && (
        <div className={`fixed inset-0 z-[100] flex items-center justify-center pointer-events-none ${isCoarsePointerDevice ? 'bg-stone-900/25' : 'bg-stone-900/20 backdrop-blur-sm'}`}>
          <div 
            className={`text-[20vw] md:text-[15rem] font-black text-amber-500 font-jua select-none ${isCoarsePointerDevice ? '' : 'animate-bounce'}`}
            style={{ 
              textShadow: '4px 4px 0 #fff, 8px 8px 0 #b45309, 0 20px 40px rgba(0,0,0,0.2)',
              WebkitTextStroke: '4px white' 
            }}
          >
            {countdown}
          </div>
        </div>
      )}

      {/* 축하 효과 오버레이 */}
      {showCelebration && (
        <div className="fixed inset-0 pointer-events-none z-[100] flex items-center justify-center overflow-hidden">
          {Array.from({ length: isCoarsePointerDevice ? 24 : 50 }).map((_, i) => (
            <div key={i} className="absolute animate-[bounce_1s_infinite]" style={{
              left: `${Math.random() * 100}%`, top: `${Math.random() * 100}%`,
              transform: `rotate(${Math.random() * 360}deg)`,
              width: '14px', height: '14px',
              backgroundColor: ['#f43f5e', '#ec4899', '#d946ef', '#a855f7', '#8b5cf6', '#6366f1', '#3b82f6', '#14b8a6', '#84cc16', '#eab308', '#f97316'][i % 11],
              borderRadius: Math.random() > 0.5 ? '50%' : '3px',
              animationDelay: `${Math.random() * 2}s`
            }} />
          ))}
        </div>
      )}

      {/* 헤더 */}
      <header className="bg-white/80 backdrop-blur-md border-b border-stone-200 px-4 lg:px-8 py-2 lg:py-3 flex items-center justify-between sticky top-0 z-40 no-print shadow-sm h-14 lg:h-auto shrink-0">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-br from-amber-400 to-orange-500 p-1.5 lg:p-2.5 rounded-xl lg:rounded-2xl shadow-lg shadow-amber-200 transform -rotate-3 hover:rotate-0 transition-transform duration-300">
            <Sparkles className="text-white w-4 h-4 lg:w-5 lg:h-5" fill="white" />
          </div>
          <h1 className="text-lg lg:text-2xl font-black tracking-tight text-stone-800 font-jua mt-1">자리 바꾸기</h1>
        </div>
        
        <div className="flex items-center gap-2 lg:gap-3">
          {view === 'layout' && (
            <div className="flex items-center bg-stone-100 rounded-2xl p-1 gap-1 border border-stone-200 mr-2">
              <button 
                onClick={() => { audioService.playClick(); setEditMode(editMode === 'position' ? 'none' : 'position'); }} 
                className={`flex items-center gap-2 px-3 py-1.5 lg:px-4 lg:py-2 rounded-xl text-sm font-bold transition-all ${editMode === 'position' ? 'bg-white text-amber-600 shadow-sm ring-1 ring-black/5' : 'text-stone-400 hover:text-stone-600 hover:bg-stone-200/50'}`}
              >
                <Move size={16} />
                <span className="font-jua text-sm lg:text-base pt-0.5 hidden sm:inline">이동</span>
              </button>
              <button 
                onClick={() => { audioService.playClick(); setEditMode(editMode === 'pair' ? 'none' : 'pair'); }} 
                className={`flex items-center gap-2 px-3 py-1.5 lg:px-4 lg:py-2 rounded-xl text-sm font-bold transition-all ${editMode === 'pair' ? 'bg-white text-amber-600 shadow-sm ring-1 ring-black/5' : 'text-stone-400 hover:text-stone-600 hover:bg-stone-200/50'}`}
              >
                <Users size={16} />
                <span className="font-jua text-sm lg:text-base pt-0.5 hidden sm:inline">짝</span>
              </button>
              <button 
                onClick={() => { audioService.playClick(); setEditMode(editMode === 'group' ? 'none' : 'group'); }} 
                className={`flex items-center gap-2 px-3 py-1.5 lg:px-4 lg:py-2 rounded-xl text-sm font-bold transition-all ${editMode === 'group' ? 'bg-white text-amber-600 shadow-sm ring-1 ring-black/5' : 'text-stone-400 hover:text-stone-600 hover:bg-stone-200/50'}`}
              >
                <Layers size={16} />
                <span className="font-jua text-sm lg:text-base pt-0.5 hidden sm:inline">모둠</span>
              </button>
            </div>
          )}

          {view === 'layout' ? (
            <button 
              onClick={handleEnterSettings} 
              className="flex items-center gap-2 px-3 py-1.5 lg:px-6 lg:py-2.5 rounded-xl lg:rounded-2xl transition-all font-bold text-sm border-2 shadow-sm text-stone-600 hover:bg-stone-50 border-stone-200 bg-white hover:border-stone-300"
            >
              <SettingsIcon size={18} /> <span className="font-jua text-sm lg:text-lg pt-0.5 hidden sm:inline">설정</span>
            </button>
          ) : (
            <button 
              onClick={handleSaveAndExitSettings}
              className="flex items-center gap-2 px-4 py-2 lg:px-6 lg:py-2.5 rounded-2xl transition-all font-bold text-sm border-2 shadow-sm bg-amber-500 text-amber-950 border-amber-500 shadow-amber-200 hover:bg-amber-400 active:scale-95 active:shadow-none active:translate-y-0.5"
            >
              <HomeIcon size={18} /> <span className="font-jua text-sm lg:text-lg pt-0.5">저장 후 교실로</span>
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">
        {view === 'layout' ? (
          <>
            {/* 사이드바 메뉴 (모바일: 하단 컨트롤 패널 / 데스크톱: 좌측 사이드바) */}
            <div className="w-full lg:w-[300px] bg-white border-t lg:border-t-0 lg:border-r border-stone-200 p-3 lg:p-6 flex flex-col gap-3 lg:gap-6 z-30 no-print flex-shrink-0 relative shadow-[0_-4px_24px_-12px_rgba(0,0,0,0.1)] lg:shadow-[4px_0_24px_-12px_rgba(0,0,0,0.1)] order-2 lg:order-1 overflow-y-auto lg:overflow-visible h-auto max-h-[35vh] lg:max-h-none lg:h-auto">
              <section className="flex flex-col gap-4">
                <button 
                  onClick={handleShuffleStart}
                  disabled={isShuffling || countdown !== null}
                  className={`
                    w-full flex lg:flex-col items-center justify-center gap-3 lg:gap-2 py-3 lg:py-8 rounded-[1rem] lg:rounded-[2rem] text-xl lg:text-2xl font-black transition-all duration-200 font-jua group relative overflow-hidden
                    ${isShuffling 
                      ? 'bg-stone-400 text-white cursor-not-allowed opacity-50' 
                      : 'bg-gradient-to-b from-amber-400 to-amber-500 text-amber-950 shadow-[0_4px_0_#b45309,0_8px_15px_-5px_rgba(180,83,9,0.4)] lg:shadow-[0_8px_0_#b45309,0_15px_20px_-5px_rgba(180,83,9,0.4)] hover:-translate-y-1 active:translate-y-[4px] active:shadow-none'
                    }
                  `}
                >
                  <div className="absolute inset-x-0 top-0 w-2 lg:h-3 bg-white/20 rounded-t-[2rem]"></div>
                  <RefreshCw strokeWidth={3} className={`relative z-10 drop-shadow-sm w-5 h-5 lg:w-9 lg:h-9 ${isShuffling ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
                  <span className="mt-0.5 lg:mt-1 relative z-10 drop-shadow-sm">{isShuffling ? `${countdown}초!` : '자리 섞기'}</span>
                </button>
              </section>

              <section className="grid grid-cols-3 lg:flex lg:flex-col gap-2 lg:gap-3 pb-safe">
                <div className="col-span-3 rounded-xl lg:rounded-2xl border border-stone-100 bg-stone-50 p-2 lg:p-3">
                  <div className="mb-2 px-1 text-[10px] lg:text-sm font-black text-stone-500 font-jua">출력 관점</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => { audioService.playClick(); setLayoutPerspective('teacher'); }}
                      className={`rounded-xl px-2 py-2.5 text-[11px] lg:text-sm font-black transition-all ${
                        layoutPerspective === 'teacher'
                          ? 'bg-white text-amber-700 border-2 border-amber-300 shadow-sm'
                          : 'bg-stone-100 text-stone-500 border-2 border-transparent hover:bg-white'
                      }`}
                    >
                      교사 관점
                    </button>
                    <button
                      onClick={() => { audioService.playClick(); setLayoutPerspective('student'); }}
                      className={`rounded-xl px-2 py-2.5 text-[11px] lg:text-sm font-black transition-all ${
                        layoutPerspective === 'student'
                          ? 'bg-white text-amber-700 border-2 border-amber-300 shadow-sm'
                          : 'bg-stone-100 text-stone-500 border-2 border-transparent hover:bg-white'
                      }`}
                    >
                      학생 관점
                    </button>
                  </div>
                </div>
                <button 
                  onClick={handleCapture}
                  disabled={isCapturing}
                  className="flex flex-col lg:flex-row items-center justify-center lg:justify-start gap-1 lg:gap-3 w-full p-2 lg:p-3.5 rounded-xl lg:rounded-2xl bg-stone-50 border border-stone-100 hover:border-amber-200 hover:bg-amber-50/50 transition-all text-stone-600 group"
                >
                  <div className="bg-white p-1.5 lg:p-2.5 rounded-lg lg:rounded-xl shadow-sm border border-stone-100 group-hover:border-amber-100 group-hover:text-amber-600 transition-colors"><Camera size={18} /></div>
                  <span className="font-bold text-[10px] lg:text-base font-jua pt-0.5">{isCapturing ? '캡쳐 중...' : '이미지 캡쳐'}</span>
                </button>
                <button 
                  onClick={triggerSaveModal}
                  className="flex flex-col lg:flex-row items-center justify-center lg:justify-start gap-1 lg:gap-3 w-full p-2 lg:p-3.5 rounded-xl lg:rounded-2xl bg-stone-50 border border-stone-100 hover:border-amber-200 hover:bg-amber-50/50 transition-all text-stone-600 group"
                >
                  <div className="bg-white p-1.5 lg:p-2.5 rounded-lg lg:rounded-xl shadow-sm border border-stone-100 group-hover:border-amber-100 group-hover:text-amber-600 transition-colors"><Save size={18} /></div>
                  <span className="font-bold text-[10px] lg:text-base font-jua pt-0.5">현재 배치 저장</span>
                </button>
                <button 
                  onClick={() => { audioService.playClick(); setIsHistoryOpen(true); }}
                  className="flex flex-col lg:flex-row items-center justify-center lg:justify-start gap-1 lg:gap-3 w-full p-2 lg:p-3.5 rounded-xl lg:rounded-2xl bg-stone-50 border border-stone-100 hover:border-amber-200 hover:bg-amber-50/50 transition-all text-stone-600 group"
                >
                  <div className="bg-white p-1.5 lg:p-2.5 rounded-lg lg:rounded-xl shadow-sm border border-stone-100 group-hover:border-amber-100 group-hover:text-amber-600 transition-colors"><History size={18} /></div>
                  <span className="font-bold text-[10px] lg:text-base font-jua pt-0.5">추억 저장소</span>
                </button>
              </section>
              
              <div className="mt-auto opacity-40 hover:opacity-100 transition-opacity hidden lg:block">
                 <div className="w-full rounded-2xl border-2 border-dashed border-stone-200 p-4 flex flex-col items-center text-center gap-2">
                    <span className="text-xs font-bold text-stone-400 font-jua">오늘도 즐거운 하루 되세요!</span>
                 </div>
              </div>
            </div>

            {/* 교실 배치 영역 (모바일: 상단 / 데스크톱: 우측) */}
            <div className="flex-1 overflow-hidden flex flex-col items-center justify-center p-4 lg:p-12 bg-[#fdfbf7] relative order-1 lg:order-2 h-full">
              {/* 배경 패턴 */}
              <div className="absolute inset-0 opacity-[0.05] pointer-events-none bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]"></div>

              {editMode !== 'none' && (
                <div className="absolute top-4 lg:top-8 z-20 animate-in slide-in-from-top duration-300 w-full flex justify-center px-4">
                  <div className="px-4 lg:px-6 py-2 lg:py-3 rounded-full border-2 border-amber-100 bg-white/90 backdrop-blur shadow-lg shadow-amber-50 flex items-center gap-2 lg:gap-3 font-bold text-sm text-amber-900 max-w-full">
                    <Info className="text-amber-500 flex-shrink-0 w-4 h-4 lg:w-[18px] lg:h-[18px]" />
                    <span className="font-jua text-sm lg:text-lg pt-0.5 truncate">
                        {editMode === 'position' 
                            ? (selectedSeat ? '이동할 빈 자리를 선택하세요.' : '이동할 책상을 선택하세요.') 
                            : editMode === 'pair'
                                ? (selectedPairSeat ? '짝을 지정할 두 번째 책상을 다시 선택하세요.' : '짝을 지정할 첫 번째 책상을 선택하세요.')
                                : '번호 선택 후 책상을 누르세요.'}
                    </span>
                  </div>
                </div>
              )}

              {editMode === 'group' && (
                <div className="absolute bottom-4 lg:bottom-10 left-1/2 -translate-x-1/2 z-50 w-full max-w-[95%] lg:max-w-none flex justify-center">
                  <div className="bg-white p-2 lg:p-2.5 rounded-[1.5rem] border border-stone-200 shadow-2xl flex items-center gap-2 lg:gap-3 overflow-x-auto max-w-full custom-scrollbar">
                    <button onClick={() => { audioService.playClick(); setSelectedGroupId(0); }} className={`p-2 lg:p-3 rounded-2xl transition-colors flex-shrink-0 ${selectedGroupId === 0 ? 'bg-stone-100 text-stone-600 shadow-inner' : 'text-stone-300 hover:text-stone-500 hover:bg-stone-50'}`}><Eraser className="w-5 h-5 lg:w-6 lg:h-6" /></button>
                    <div className="w-0.5 h-6 lg:h-8 bg-stone-100 flex-shrink-0"></div>
                    <div className="flex items-center gap-1 lg:gap-2 px-1">
                      {[1,2,3,4,5,6,7,8].map(id => (
                        <button key={id} onClick={() => { audioService.playClick(); setSelectedGroupId(id); }} className={`w-9 h-9 lg:w-11 lg:h-11 rounded-xl lg:rounded-2xl border-2 transition-all flex items-center justify-center font-black text-base lg:text-lg font-jua flex-shrink-0 ${GROUP_COLORS[id]} ${selectedGroupId === id ? 'ring-2 lg:ring-4 ring-amber-200 ring-offset-0 scale-110 shadow-lg -translate-y-1 z-10' : 'hover:scale-105 hover:shadow-md'}`}>{id}</button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div ref={layoutContainerRef} className="w-full h-full flex items-center justify-center relative z-10">
                <LayoutView 
                  seats={seats} 
                  range={visibleRange}
                  perspective={layoutPerspective}
                  editMode={editMode}
                  onSeatClick={handleSeatInteraction}
                  isShuffling={isShuffling}
                  isCapturing={isCapturing}
                  shufflingOffsets={shufflingOffsets}
                  onMove={handleSeatMove}
                  selectedSeat={selectedSeat}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="w-full flex flex-col items-center bg-[#fdfbf7] overflow-y-auto custom-scrollbar pt-6 lg:pt-10 pb-20">
            <div className="w-full max-w-5xl px-4 lg:px-8 flex flex-col gap-6 lg:gap-8">
              <div className="w-full border-2 border-amber-100 rounded-[2rem] p-4 lg:p-6 bg-white shadow-xl shadow-amber-50/50">
                <div className="grid grid-cols-1 gap-3">
                  <button
                    onClick={handleSettingsTabClick}
                    className={`w-full px-4 py-3 lg:py-4 rounded-2xl border-2 font-bold text-sm lg:text-base transition-all ${
                      view === 'settings-students' || view === 'settings-shuffle'
                        ? 'bg-amber-50 border-amber-300 text-amber-700 shadow-sm'
                        : 'bg-white border-stone-200 text-stone-500 hover:border-amber-200 hover:text-amber-600'
                    }`}
                  >
                    명단 관리
                  </button>
                </div>
              </div>

              {view === 'settings-shuffle' ? (
                <ShuffleSettingsView
                  settings={shuffleSettings}
                  students={config.students}
                  positions={config.positions}
                  perspective={layoutPerspective}
                  onChange={setShuffleSettings}
                />
              ) : (
                <SettingsView students={editingStudents} onChange={setEditingStudents} />
              )}

              <button
                type="button"
                onClick={handleRequestResetAllSettings}
                onPointerDown={handleRequestResetAllSettings}
                onTouchStart={handleRequestResetAllSettings}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 lg:py-4 rounded-2xl border-2 border-rose-200 bg-white text-rose-600 font-black text-sm lg:text-base transition-all hover:bg-rose-50"
              >
                전체 설정 초기화
              </button>
            </div>
          </div>
        )}

        {isResetSettingsConfirmOpen && (
          <div className="fixed inset-0 z-[260] bg-black/50 backdrop-blur-sm flex items-center justify-center animate-in fade-in duration-200">
            <div className="bg-white p-6 md:p-8 rounded-[2rem] shadow-2xl max-w-sm w-full mx-4 flex flex-col items-center text-center border-4 border-stone-100">
              <div className="p-4 rounded-full mb-4 ring-4 bg-rose-100 text-rose-500 ring-rose-50">
                <Trash2 size={32} />
              </div>
              <h3 className="text-2xl font-black text-stone-800 mb-2 font-jua">설정 전체를 초기화할까요?</h3>
              <p className="text-stone-500 font-medium mb-8 text-sm leading-relaxed">
                명단과 자리 섞기 설정이 기본값으로 바뀝니다.
              </p>
              <div className="flex w-full gap-3">
                <button
                  onClick={() => setIsResetSettingsConfirmOpen(false)}
                  className="flex-1 py-3.5 rounded-xl font-bold text-stone-400 hover:bg-stone-100 transition-colors font-jua text-lg"
                >
                  취소
                </button>
                <button
                  onClick={handleResetAllSettings}
                  className="flex-1 py-3.5 rounded-xl font-bold shadow-md transition-all active:scale-95 font-jua text-lg bg-rose-500 text-white hover:bg-rose-600 shadow-rose-200"
                >
                  초기화
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

interface LayoutViewProps {
  seats: Seat[];
  range: { startR: number, endR: number, startC: number, endC: number };
  perspective: LayoutPerspective;
  editMode: EditModeType;
  onSeatClick: (r: number, c: number) => void;
  isShuffling: boolean;
  isCapturing: boolean;
  shufflingOffsets: Record<string, { x: number, y: number }>;
  onMove: (from: {r: number, c: number}, to: {r: number, c: number}) => void;
  selectedSeat: {r: number, c: number} | null;
}

const LayoutView: React.FC<LayoutViewProps> = ({ seats, range, perspective, editMode, onSeatClick, isShuffling, isCapturing, shufflingOffsets, onMove, selectedSeat }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [dragOverPos, setDragOverPos] = useState<string | null>(null);

  const cols = range.endC - range.startC + 1;
  const rows = range.endR - range.startR + 1;
  const seatWidth = 120;
  const seatHeight = seatWidth / 1.3;
  const gapX = 24;
  const gapY = 40;
  const gridWidth = cols * seatWidth + Math.max(0, cols - 1) * gapX;
  const gridHeight = rows * seatHeight + Math.max(0, rows - 1) * gapY;
  const overlayPad = 28;
  const isTeacherPerspective = perspective === 'teacher';
  const toVisualRow = useCallback((row: number) => {
    return isTeacherPerspective ? range.endR - row + range.startR : row;
  }, [isTeacherPerspective, range.endR, range.startR]);
  const toVisualCol = useCallback((col: number) => {
    return isTeacherPerspective ? range.endC - col + range.startC : col;
  }, [isTeacherPerspective, range.endC, range.startC]);

  const groupAreas = useMemo(() => {
    const groupedSeats: Record<number, Array<{ r: number; c: number }>> = {};
    seats.forEach((seat) => {
      if (!seat.isActive || !seat.groupId) return;
      if (!groupedSeats[seat.groupId]) groupedSeats[seat.groupId] = [];
      groupedSeats[seat.groupId].push({ r: seat.r, c: seat.c });
    });

    const areas: Array<{ areaId: string; groupId: number; color: string; pathD: string }> = [];
    const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    const keyOf = (p: { r: number; c: number }) => `${p.r},${p.c}`;
    const parseKey = (key: string) => {
      const [r, c] = key.split(',').map(Number);
      return { r, c };
    };

    const getComponents = (cellSet: Set<string>) => {
      const visited = new Set<string>();
      const comps: string[][] = [];
      cellSet.forEach((start) => {
        if (visited.has(start)) return;
        const queue: string[] = [start];
        visited.add(start);
        const comp: string[] = [];
        while (queue.length) {
          const cur = queue.shift()!;
          comp.push(cur);
          const { r, c } = parseKey(cur);
          dirs.forEach(([dr, dc]) => {
            const nk = `${r + dr},${c + dc}`;
            if (cellSet.has(nk) && !visited.has(nk)) {
              visited.add(nk);
              queue.push(nk);
            }
          });
        }
        comps.push(comp);
      });
      return comps;
    };

    const createPath = (cells: Array<{ r: number; c: number }>) => {
      const edgeSet = new Map<string, [number, number][]>();
      const edgeKey = (a: [number, number], b: [number, number]) => {
        if (a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1])) return `${a[0]},${a[1]}|${b[0]},${b[1]}`;
        return `${b[0]},${b[1]}|${a[0]},${a[1]}`;
      };
      const addEdge = (a: [number, number], b: [number, number]) => {
        const k = edgeKey(a, b);
        const existing = edgeSet.get(k);
        if (existing) {
          edgeSet.delete(k);
          return;
        }
        edgeSet.set(k, [a, b]);
      };

      const toLocal = (r: number, c: number) => [toVisualCol(c) - range.startC, toVisualRow(r) - range.startR] as [number, number];
      const localCellSet = new Set(cells.map((p) => `${p.r},${p.c}`));

      cells.forEach((cell) => {
        if (!localCellSet.has(`${cell.r},${cell.c}`)) return;
        const p = toLocal(cell.r, cell.c);
        const p1: [number, number] = [p[0], p[1]];
        const p2: [number, number] = [p[0] + 1, p[1]];
        const p3: [number, number] = [p[0] + 1, p[1] + 1];
        const p4: [number, number] = [p[0], p[1] + 1];
        addEdge(p1, p2);
        addEdge(p2, p3);
        addEdge(p3, p4);
        addEdge(p4, p1);
      });

      if (edgeSet.size === 0) return '';

      const adj = new Map<string, string[]>();
      edgeSet.forEach(([a, b]) => {
        const ka = `${a[0]},${a[1]}`;
        const kb = `${b[0]},${b[1]}`;
        if (!adj.has(ka)) adj.set(ka, []);
        if (!adj.has(kb)) adj.set(kb, []);
        adj.get(ka)!.push(kb);
        adj.get(kb)!.push(ka);
      });

      const keyPoints = Array.from(adj.keys());
      const start = keyPoints.reduce((acc, cur) => {
        const [ax, ay] = acc.split(',').map(Number);
        const [cx, cy] = cur.split(',').map(Number);
        if (cy < ay || (cy === ay && cx < ax)) return cur;
        return acc;
      }, keyPoints[0]);

      if (!start) return '';

      const loop: string[] = [];
      let prev: string | null = null;
      let current = start;
      let guard = 0;

      while (guard < 2000) {
        guard += 1;
        loop.push(current);
        const neighbors = adj.get(current) || [];
        const next = neighbors.find((n) => n !== prev) || neighbors[0];
        if (!next) break;
        prev = current;
        current = next;
        if (current === start) break;
      }

      const pts = loop.map((k) => k.split(',').map(Number) as [number, number]);
      const stepX = seatWidth + gapX;
      const stepY = seatHeight + gapY;
      const inset = 0.92;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      return (
        pts.map(([x, y], idx) => {
          const ix = centerX + (x - centerX) * inset;
          const iy = centerY + (y - centerY) * inset;
          const px = overlayPad + ix * stepX;
          const py = overlayPad + iy * stepY;
          return `${idx === 0 ? 'M' : 'L'} ${px} ${py}`;
        }).join(' ') + ' Z'
      );
    };

    Object.entries(groupedSeats).forEach(([rawGroupId, cells]) => {
      const g = Number(rawGroupId);
      const colorIdx = Number.isFinite(g) ? Math.abs(g) % GROUP_AREA_COLORS.length : 0;
      const groupCellSet = new Set(cells.map(keyOf));
      const components = getComponents(groupCellSet);

      components.forEach((component, idx) => {
        areas.push({
          areaId: `${g}-${idx}-${component.length}`,
          groupId: g,
          color: GROUP_AREA_COLORS[colorIdx] || GROUP_AREA_COLORS[0],
          pathD: createPath(component.map(parseKey)),
        });
      });
    });

    return areas;
  }, [range.startC, range.startR, seats, toVisualCol, toVisualRow]);

  const renderedSeats = useMemo(() => {
    return [...seats].sort((a, b) => {
      const rowDiff = toVisualRow(a.r) - toVisualRow(b.r);
      if (rowDiff !== 0) return rowDiff;
      return toVisualCol(a.c) - toVisualCol(b.c);
    });
  }, [seats, toVisualCol, toVisualRow]);

  useEffect(() => {
    const updateScale = () => {
      if (containerRef.current) {
        const cw = containerRef.current.offsetWidth;
        const ch = containerRef.current.offsetHeight;
        // 여백을 포함한 그리드 전체 크기 추정
        const gw = cols * 130 + 40; // 120px + gap
        const rows = range.endR - range.startR + 1;
        const gh = 200 + (rows * 120); // 칠판 높이 + 좌석 높이
        
        // 화면에 꽉 차게 보이되, 너무 작아지지 않도록 조정
        // 모바일에서는 조금 더 여백을 줄여서 크게 보이도록 0.95 비율 적용
        const maxScale = window.innerWidth < 1024 ? 1.0 : 1.2;
        setScale(Math.min(cw / gw, ch / gh, maxScale));
      }
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, [cols, range]);

  return (
    <div ref={containerRef} className="w-full h-full relative flex flex-col items-center justify-center">
      <div className="layout-content flex flex-col items-center transition-transform duration-700 ease-out origin-center" style={{ transform: `scale(${scale})` }}>
        <div className={`capture-target inline-flex items-center ${isTeacherPerspective ? 'flex-col-reverse' : 'flex-col'}`}>
        {/* 칠판 영역 */}
        <div className={`w-full max-w-[680px] ${isTeacherPerspective ? 'mt-14' : 'mb-14'} flex flex-col items-center transition-opacity ${isShuffling ? 'opacity-20' : ''}`}>
          <div className={`w-full h-20 rounded-xl border-[8px] border-[#8b5a2b] flex items-center justify-center relative chalkboard-texture overflow-hidden ${isCapturing ? 'shadow-md' : 'shadow-2xl'}`}>
             {/* 분필 가루 효과 */}
             <div className={`absolute top-1/2 left-1/4 w-32 h-20 bg-white/5 rounded-full rotate-12 ${isCapturing ? '' : 'blur-xl'}`}></div>
             <div className="absolute inset-x-0 -bottom-3 h-3 bg-[#6d4520] rounded-b-lg shadow-md mx-1"></div>
             <span className="text-white/90 text-4xl tracking-[0.3em] ml-[0.3em] select-none drop-shadow-md whitespace-nowrap leading-none font-jua">칠판</span>
             <div className={`absolute bottom-2 right-4 w-12 h-3 bg-stone-200/20 rounded-sm rotate-1 ${isCapturing ? '' : 'backdrop-blur-[1px]'}`}></div>
          </div>
        </div>

        <div className="relative">
          <div className="absolute inset-0 pointer-events-none z-0">
            <svg
              width={gridWidth + overlayPad * 2}
              height={gridHeight + overlayPad * 2}
              style={{
                position: 'absolute',
                left: -overlayPad,
                top: -overlayPad,
                overflow: 'visible',
              }}
            >
              {groupAreas.map((area) => (
                <path
                  key={`group-${area.areaId}`}
                  d={area.pathD}
                  fill={`${area.color}28`}
                  stroke={`${area.color}9a`}
                  strokeWidth={8}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={0.95}
                />
              ))}
            </svg>
          </div>
          <div className="seating-grid grid gap-x-6 gap-y-10 transition-all duration-500 relative z-10" style={{ gridTemplateColumns: `repeat(${cols}, 120px)` }}>
          {renderedSeats.map((seat) => {
            const posKey = `${seat.r},${seat.c}`;
            const offset = shufflingOffsets[posKey] || { x: 0, y: 0 };
            const isOver = dragOverPos === posKey;
            // 선택된 좌석인지 확인
            const isSelected = selectedSeat?.r === seat.r && selectedSeat?.c === seat.c;
            const pairPartner = seat.pairId
              ? seats.find(s => s.pairId === seat.pairId && (s.r !== seat.r || s.c !== seat.c))
              : null;
            const pairTranslate = pairPartner && (Math.abs(pairPartner.r - seat.r) + Math.abs(pairPartner.c - seat.c) === 1)
              ? (() => {
                  const dx = toVisualCol(pairPartner.c) - toVisualCol(seat.c);
                  const dy = toVisualRow(pairPartner.r) - toVisualRow(seat.r);
                  const pairCompensateX = 8;
                  const targetPairGap = gapX - pairCompensateX * 2;
                  const pairCompensateY = Math.max(0, (gapY - targetPairGap) / 2);
                  if (Math.abs(dx) === 1) return { x: dx > 0 ? pairCompensateX : -pairCompensateX, y: 0 };
                  if (Math.abs(dy) === 1) return { x: 0, y: dy > 0 ? pairCompensateY : -pairCompensateY };
                  return { x: 0, y: 0 };
                })()
              : { x: 0, y: 0 };
            
            return (
              <div 
                key={posKey}
                draggable={editMode === 'position' && seat.isActive}
                onDragStart={(e) => {
                  e.dataTransfer.setData('fromPos', JSON.stringify({ r: seat.r, c: seat.c }));
                  e.currentTarget.style.opacity = '0.3';
                }}
                onDragEnd={(e) => {
                  e.currentTarget.style.opacity = '1';
                  setDragOverPos(null);
                }}
                onDragOver={(e) => {
                  if (editMode !== 'position') return;
                  e.preventDefault();
                  setDragOverPos(posKey);
                }}
                onDrop={(e) => {
                  if (editMode !== 'position') return;
                  e.preventDefault();
                  const fromPos = JSON.parse(e.dataTransfer.getData('fromPos'));
                  onMove(fromPos, { r: seat.r, c: seat.c });
                  setDragOverPos(null);
                }}
                onClick={() => onSeatClick(seat.r, seat.c)}
                className={`
                  relative aspect-[1.3/1] perspective-[1000px]
                  ${!isShuffling ? 'transition-all duration-500' : ''}
                  ${seat.isActive ? '' : 'opacity-0'}
                  ${editMode === 'position' && seat.isActive ? 'cursor-grab hover:-translate-y-2' : ''}
                  ${editMode === 'position' && !seat.isActive ? 'opacity-30 border-2 border-dashed border-stone-400 cursor-pointer hover:border-amber-400 hover:bg-amber-50 rounded-xl' : ''}
                  ${isShuffling && seat.isActive ? 'z-50 will-change-transform' : ''}
                  ${isOver ? 'scale-110 z-50' : ''}
                  ${seat.pairId ? 'shadow-[0_0_0_1px_rgba(217,119,6,0.2)]' : ''}
                  ${isSelected ? 'scale-110 z-50 ring-4 ring-amber-400 ring-offset-4 rounded-xl shadow-xl' : ''}
                `}
                style={isShuffling && seat.isActive ? {
                  transform: `translate(${offset.x + pairTranslate.x}px, ${offset.y + pairTranslate.y}px) rotate(${(offset.x + offset.y) * 0.08}deg)`,
                  transition: 'transform 0.4s ease-in-out'
                } : (seat.pairId ? { transform: `translate(${pairTranslate.x}px, ${pairTranslate.y}px)` } : {})}
              >
                {seat.isActive && seat.student && (
                  <>
                    {/* 책상 디자인 (나무 질감) */}
                    <div className={`w-full h-full bg-[#f3d09a] rounded-lg border-t-2 border-[#ffe4b5] relative overflow-hidden flex flex-col items-center justify-center p-2 group transition-transform shadow-[0_6px_0_#d6b076,0_15px_20px_-5px_rgba(0,0,0,0.15)]
                      ${GROUP_COLORS[seat.groupId]}
                      ${isOver ? 'ring-4 ring-amber-400 ring-offset-2' : ''}
                    `}>
                        {/* 나무결 패턴 (CSS) */}
                        <div className="absolute inset-0 opacity-10 bg-[linear-gradient(45deg,transparent_25%,#000_25%,#000_50%,transparent_50%,transparent_75%,#000_75%,#000_100%)] [background-size:4px_4px]"></div>

                        {/* 이름표 (종이 느낌) */}
                        <div className="bg-white w-[90%] h-[80%] rounded shadow-sm flex flex-col items-center justify-center relative transform rotate-[0.5deg] border border-stone-100">
                            {/* 상단 테이프 효과 */}
                            <div className="absolute -top-2 w-12 h-4 bg-white/40 border-l border-r border-white/60 backdrop-blur-[1px] transform -rotate-1 shadow-sm opacity-70"></div>

                            {!isShuffling && seat.groupId > 0 && (
                              <div className={`absolute -top-1.5 -left-1.5 w-6 h-6 rounded-full flex items-center justify-center text-xs font-black text-white shadow-md border-2 border-white ${GROUP_BADGE_COLORS[seat.groupId]}`}>
                                {seat.groupId}
                              </div>
                            )}

                            <span className="font-jua text-stone-800 text-2xl truncate w-full text-center px-1 leading-none mt-1.5 tracking-tight">{seat.student.name}</span>
                        </div>
                    </div>
                  </>
                )}
              </div>
            );
          })}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
};

interface SettingsViewProps {
  students: Student[];
  onChange: (students: Student[]) => void;
}

const SettingsView: React.FC<SettingsViewProps> = ({ students, onChange }) => {
  // 컴포넌트 내부에서 local state를 사용하지 않고 props를 통해 상위 컴포넌트의 state를 제어합니다.
  
  const handleCountChange = (newCount: number) => {
    if (newCount < 0 || newCount > 60) return;
    if (newCount > students.length) {
      onChange([
        ...students, 
        ...Array.from({ length: newCount - students.length }, (_, i) => (
          createStudent(`학생${students.length + i + 1}`, 'M')
        ))
      ]);
    } else {
      onChange(students.slice(0, newCount));
    }
  };

  const updateStudent = (idx: number, updates: Partial<Student>) => {
    const next = [...students];
    next[idx] = { ...next[idx], ...updates };
    onChange(next);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key === 'Tab') {
      const inputs = document.querySelectorAll('.student-name-input');
      const targetIndex = e.shiftKey ? index - 1 : index + 1;
      if (targetIndex >= 0 && targetIndex < inputs.length) {
        e.preventDefault();
        (inputs[targetIndex] as HTMLInputElement).focus();
      }
    }
  };

  const maleCount = students.filter(s => s.gender === 'M').length;
  const femaleCount = students.filter(s => s.gender === 'F').length;
  const studentsPerRow = 4;
  const studentItems = (() => {
    const nodes: JSX.Element[] = [];

    for (let rowStart = 0; rowStart < students.length; rowStart += studentsPerRow) {
      const rowItems = students.slice(rowStart, rowStart + studentsPerRow);
      const isLastRow = rowStart + studentsPerRow >= students.length;

      rowItems.forEach((s, offset) => {
        const i = rowStart + offset;
        const hasVerticalDivider = offset < rowItems.length - 1;
        nodes.push(
          <div
            key={s.id}
            className={`relative flex flex-col gap-2 lg:gap-3 p-4 lg:p-5 rounded-2xl lg:rounded-3xl border-2 border-stone-100 bg-white hover:border-amber-300 transition-all shadow-sm hover:shadow-[0_8px_16px_-4px_rgba(245,158,11,0.1)] group overflow-hidden ${
              hasVerticalDivider ? 'pr-4 after:absolute after:top-0 after:bottom-0 after:right-[-0.75rem] after:w-px after:bg-stone-200' : ''
            }`}
          >
            <div className="absolute top-0 left-0 w-full h-1.5 bg-stone-100 group-hover:bg-amber-400 transition-colors"></div>
            <div className="flex items-center justify-between gap-2 lg:gap-3 pt-2">
              <div className="flex items-center gap-2 lg:gap-3 flex-1 overflow-hidden">
                <span className="text-xs lg:text-sm font-black text-stone-300 w-5 lg:w-6 font-jua pt-1 flex-shrink-0">{i + 1}</span>
                <input
                  value={s.name}
                  onChange={e => updateStudent(i, { name: e.target.value })}
                  onKeyDown={e => handleKeyDown(e, i)}
                  className="student-name-input w-full bg-transparent border-none text-xl lg:text-2xl font-bold text-stone-800 outline-none placeholder-stone-200 font-jua pt-1 min-w-0"
                  placeholder="이름"
                />
              </div>
              <button
                onClick={() => { audioService.playClick(); onChange(students.filter((_, idx) => idx !== i)); }}
                className="text-stone-200 hover:text-rose-500 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0"
              >
                <Trash2 className="w-4 h-4 lg:w-[18px] lg:h-[18px]" />
              </button>
            </div>

            <div className="flex gap-2 mt-1">
              <button
                onClick={() => { audioService.playClick(); updateStudent(i, { gender: 'M' }); }}
                className={`flex-1 py-1 lg:py-1.5 rounded-lg lg:rounded-xl text-xs lg:text-sm font-black transition-all border-2 font-jua ${s.gender === 'M' ? 'bg-blue-50 border-blue-200 text-blue-500' : 'bg-stone-50 border-stone-100 text-stone-300 hover:border-stone-200'}`}
              >
                남
              </button>
              <button
                onClick={() => { audioService.playClick(); updateStudent(i, { gender: 'F' }); }}
                className={`flex-1 py-1 lg:py-1.5 rounded-lg lg:rounded-xl text-xs lg:text-sm font-black transition-all border-2 font-jua ${s.gender === 'F' ? 'bg-rose-50 border-rose-200 text-rose-500' : 'bg-stone-50 border-stone-100 text-stone-300 hover:border-stone-200'}`}
              >
                여
              </button>
            </div>
          </div>
        );
      });

      if (!isLastRow) {
        nodes.push(
          <div
            key={`divider-${rowStart}`}
            className="col-span-full h-px bg-stone-200 rounded-full"
          />
        );
      }
    }

    nodes.push(
      <button
        key="add-student-btn"
        onClick={() => { audioService.playClick(); handleCountChange(students.length + 1); }}
        className="flex flex-col items-center justify-center gap-2 lg:gap-3 min-h-[120px] lg:min-h-[140px] rounded-2xl lg:rounded-3xl border-3 border-dashed border-stone-200 text-stone-400 font-bold hover:bg-stone-50 hover:border-amber-300 hover:text-amber-400 transition-all"
      >
        <div className="bg-white p-2 lg:p-3 rounded-full shadow-sm">
          <PlusCircle className="w-5 h-5 lg:w-6 lg:h-6" />
        </div>
        <span className="text-sm font-jua lg:text-lg">학생 추가하기</span>
      </button>
    );

    return nodes;
  })();

  return (
    <div className="w-full max-w-5xl px-4 lg:px-8 flex flex-col gap-6 lg:gap-8 animate-in fade-in duration-500">
      <div className="flex flex-col lg:flex-row items-center justify-between border-2 border-amber-100 rounded-[2rem] lg:rounded-[2.5rem] p-6 lg:p-8 bg-white shadow-xl shadow-amber-50/50 gap-6">
        <div className="flex items-center gap-4 lg:gap-6 w-full lg:w-auto">
          <div className="bg-amber-50 p-3 lg:p-4 rounded-3xl border border-amber-100 text-amber-500"><Users className="w-6 h-6 lg:w-8 lg:h-8" /></div>
          <div>
            <h2 className="text-2xl lg:text-3xl font-black text-stone-800 leading-none mb-1 lg:mb-2 font-jua">우리 반 명단</h2>
            <p className="text-stone-500 text-xs lg:text-base font-medium">번호 순서대로 이름을 적어주세요.</p>
          </div>
        </div>

        <div className="flex flex-wrap justify-center items-center gap-4 lg:gap-8 w-full lg:w-auto">
          <div className="flex items-center gap-3 lg:gap-4 text-xs lg:text-sm font-bold">
            <div className="flex items-center gap-2 px-4 py-2 lg:px-5 lg:py-3 bg-stone-50 border border-stone-200 rounded-2xl">
              <span className="text-blue-500 text-lg lg:text-xl font-jua">남</span> <span className="text-stone-900 ml-1 text-lg lg:text-xl font-jua">{maleCount}</span>
            </div>
            <div className="flex items-center gap-2 px-4 py-2 lg:px-5 lg:py-3 bg-stone-50 border border-stone-200 rounded-2xl">
              <span className="text-rose-500 text-lg lg:text-xl font-jua">여</span> <span className="text-stone-900 ml-1 text-lg lg:text-xl font-jua">{femaleCount}</span>
            </div>
          </div>
          
          <div className="flex items-center gap-3 lg:gap-4 bg-white px-4 py-2 lg:px-6 lg:py-3 rounded-2xl border-2 border-stone-200 shadow-sm ml-auto">
            <span className="text-[10px] lg:text-xs font-black text-stone-400 uppercase tracking-tighter">총 인원</span>
            <input 
              type="number" 
              value={students.length} 
              onChange={(e) => handleCountChange(parseInt(e.target.value) || 0)}
              className="w-10 lg:w-12 text-2xl lg:text-3xl font-black text-amber-500 bg-transparent text-center outline-none font-jua"
            />
            <div className="flex flex-col gap-1">
              <button onClick={() => { audioService.playClick(); handleCountChange(students.length + 1); }} className="hover:text-amber-600 text-stone-300 transition-colors"><ChevronUp className="w-3.5 h-3.5 lg:w-4 lg:h-4" strokeWidth={3} /></button>
              <button onClick={() => { audioService.playClick(); handleCountChange(students.length - 1); }} className="hover:text-rose-600 text-stone-300 transition-colors"><ChevronDown className="w-3.5 h-3.5 lg:w-4 lg:h-4" strokeWidth={3} /></button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 gap-3 lg:gap-5 pb-12">
        {studentItems}
      </div>

    </div>
  );
};

interface ShuffleSettingsViewProps {
  settings: ShuffleSettings;
  students: Student[];
  positions: Position[];
  perspective: LayoutPerspective;
  onChange: (settings: ShuffleSettings) => void;
}

const ShuffleSettingsView: React.FC<ShuffleSettingsViewProps> = ({ settings, students, positions, perspective, onChange }) => {
  const studentOptions = useMemo(() => {
    const totalByName = new Map<string, number>();
    const seenByName = new Map<string, number>();

    students.forEach((student) => {
      totalByName.set(student.name, (totalByName.get(student.name) || 0) + 1);
    });

    return students.map((student) => {
      const current = (seenByName.get(student.name) || 0) + 1;
      seenByName.set(student.name, current);
      const duplicateCount = totalByName.get(student.name) || 0;
      return {
        id: student.id,
        label: duplicateCount > 1 ? `${student.name} ${current}` : student.name,
      };
    });
  }, [students]);

  const labelByStudentId = useMemo(() => new Map(studentOptions.map((option) => [option.id, option.label])), [studentOptions]);
  const seatLayoutMeta = useMemo(() => {
    const uniquePositions = new Map<string, Position>();

    positions.forEach((position) => {
      const key = createSeatKey(position);
      if (!uniquePositions.has(key)) {
        uniquePositions.set(key, position);
      }
    });

    const rawPositions = [...uniquePositions.values()];
    const rs = rawPositions.map((position) => position.r);
    const cs = rawPositions.map((position) => position.c);
    const range = {
      startR: 0,
      endR: rs.length > 0 ? Math.max(...rs) : 0,
      startC: cs.length > 0 ? Math.min(...cs) : 0,
      endC: cs.length > 0 ? Math.max(...cs) : 0,
    };
    const displayedRows = Array.from({ length: range.endR - range.startR + 1 }, (_, index) => range.startR + index);
    const displayedCols = Array.from({ length: range.endC - range.startC + 1 }, (_, index) => range.startC + index);

    if (perspective === 'teacher') {
      displayedRows.reverse();
      displayedCols.reverse();
    }

    const visualRowNumberByValue = new Map(displayedRows.map((value, index) => [value, index + 1]));
    const visualColNumberByValue = new Map(displayedCols.map((value, index) => [value, index + 1]));
    const sortedPositions = [...rawPositions].sort((a, b) => {
      const rowDiff = (visualRowNumberByValue.get(a.r) || 0) - (visualRowNumberByValue.get(b.r) || 0);
      if (rowDiff !== 0) return rowDiff;
      return (visualColNumberByValue.get(a.c) || 0) - (visualColNumberByValue.get(b.c) || 0);
    });
    const seatLabelByKey = new Map(sortedPositions.map((position) => [
      createSeatKey(position),
      `${visualRowNumberByValue.get(position.r)}행 ${visualColNumberByValue.get(position.c)}열`,
    ]));
    const seatKeySet = new Set(sortedPositions.map((position) => createSeatKey(position)));

    return {
      sortedPositions,
      displayedRows,
      displayedCols,
      seatLabelByKey,
      seatKeySet,
    };
  }, [perspective, positions]);
  const seatOptions = useMemo(() => seatLayoutMeta.sortedPositions.map((position) => ({
    key: createSeatKey(position),
    label: seatLayoutMeta.seatLabelByKey.get(createSeatKey(position)) || createSeatKey(position),
  })), [seatLayoutMeta]);
  const fixedSeatRuleBySeatKey = useMemo(() => {
    const map = new Map<string, FixedSeatRule>();
    settings.fixedSeats.forEach((rule) => {
      if (rule.seatKey) {
        map.set(rule.seatKey, rule);
      }
    });
    return map;
  }, [settings.fixedSeats]);

  const applySettingsChange = useCallback((nextSettings: ShuffleSettings) => {
    onChange(sanitizeShuffleSettings(nextSettings, students, positions));
  }, [onChange, positions, students]);
  const canAddFixedSeatRule = settings.fixedSeats.length < Math.min(studentOptions.length, seatOptions.length);

  const updateListRule = (key: 'frontOnly' | 'noBackRow' | 'noSoloSeat', nextNames: string[]) => {
    applySettingsChange({ ...settings, [key]: nextNames });
  };

  const addNameToListRule = (key: 'frontOnly' | 'noBackRow' | 'noSoloSeat', studentId: string) => {
    if (!studentId) return;
    updateListRule(key, [...settings[key], studentId]);
  };

  const removeNameFromListRule = (key: 'frontOnly' | 'noBackRow' | 'noSoloSeat', studentId: string) => {
    updateListRule(key, settings[key].filter((item) => item !== studentId));
  };

  const addFixedSeatRule = () => {
    const usedStudentIds = new Set(settings.fixedSeats.map((rule) => rule.studentId));
    const usedSeatKeys = new Set(settings.fixedSeats.map((rule) => rule.seatKey));
    const nextStudentId = studentOptions.find((option) => !usedStudentIds.has(option.id))?.id;
    const nextSeatKey = seatOptions.find((option) => !usedSeatKeys.has(option.key))?.key;

    if (!nextStudentId || !nextSeatKey) return;

    applySettingsChange({
      ...settings,
      fixedSeats: [
        ...settings.fixedSeats,
        { id: createRuleId('fixed-seat-rule'), studentId: nextStudentId, seatKey: nextSeatKey },
      ],
    });
  };

  const updateFixedSeatRule = (id: string, field: 'studentId' | 'seatKey', value: string) => {
    applySettingsChange({
      ...settings,
      fixedSeats: settings.fixedSeats.map((rule) => (
        rule.id === id ? { ...rule, [field]: value } : rule
      )),
    });
  };

  const removeFixedSeatRule = (id: string) => {
    applySettingsChange({
      ...settings,
      fixedSeats: settings.fixedSeats.filter((rule) => rule.id !== id),
    });
  };

  const addForbiddenPairRule = () => {
    if (studentOptions.length < 2) return;
    applySettingsChange({
      ...settings,
      forbiddenPairs: [
        ...settings.forbiddenPairs,
        { id: createRuleId('pair-rule'), firstStudentId: studentOptions[0].id, secondStudentId: studentOptions[1].id },
      ],
    });
  };

  const updateForbiddenPairRule = (id: string, field: 'firstStudentId' | 'secondStudentId', value: string) => {
    const nextSettings = {
      ...settings,
      forbiddenPairs: settings.forbiddenPairs.map((rule) => {
        if (rule.id !== id) return rule;
        const nextRule = { ...rule, [field]: value };
        if (nextRule.firstStudentId === nextRule.secondStudentId) {
          const fallback = studentOptions.find((option) => option.id !== value)?.id || '';
          if (field === 'firstStudentId') nextRule.secondStudentId = fallback;
          else nextRule.firstStudentId = fallback;
        }
        return nextRule;
      }),
    };
    applySettingsChange(nextSettings);
  };

  const removeForbiddenPairRule = (id: string) => {
    applySettingsChange({
      ...settings,
      forbiddenPairs: settings.forbiddenPairs.filter((rule) => rule.id !== id),
    });
  };

  const addForbiddenGroupRule = () => {
    if (studentOptions.length < 2) return;
    applySettingsChange({
      ...settings,
      forbiddenGroups: [...settings.forbiddenGroups, { id: createRuleId('group-rule'), studentIds: [studentOptions[0].id, studentOptions[1].id] }],
    });
  };

  const addNameToGroupRule = (id: string, studentId: string) => {
    if (!studentId) return;
    applySettingsChange({
      ...settings,
      forbiddenGroups: settings.forbiddenGroups.map((rule) => (
        rule.id === id ? { ...rule, studentIds: [...new Set([...rule.studentIds, studentId])] } : rule
      )),
    });
  };

  const removeNameFromGroupRule = (id: string, studentId: string) => {
    applySettingsChange({
      ...settings,
      forbiddenGroups: settings.forbiddenGroups.map((rule) => (
        rule.id === id ? { ...rule, studentIds: rule.studentIds.filter((item) => item !== studentId) } : rule
      )),
    });
  };

  const removeForbiddenGroupRule = (id: string) => {
    applySettingsChange({
      ...settings,
      forbiddenGroups: settings.forbiddenGroups.filter((rule) => rule.id !== id),
    });
  };

  const renderNameChips = (studentIds: string[], onRemove: (studentId: string) => void, accent: string) => {
    if (studentIds.length === 0) {
      return <div className="text-sm text-stone-400">선택 없음</div>;
    }

    return (
      <div className="flex flex-wrap gap-2">
        {studentIds.map((studentId) => (
          <button
            key={studentId}
            onClick={() => onRemove(studentId)}
            className={`px-3 py-1.5 rounded-full text-sm font-black border ${accent}`}
          >
            {labelByStudentId.get(studentId) || '삭제된 학생'}
          </button>
        ))}
      </div>
    );
  };

  const renderFixedSeatMap = (rule: FixedSeatRule) => {
    const selectedStudentLabel = labelByStudentId.get(rule.studentId) || '학생';
    const selectedSeatLabel = seatLayoutMeta.seatLabelByKey.get(rule.seatKey) || '자리 선택';

    if (seatLayoutMeta.displayedRows.length === 0 || seatLayoutMeta.displayedCols.length === 0) {
      return <div className="text-sm text-stone-400">좌석 정보가 없습니다.</div>;
    }

    return (
      <div className="rounded-[1.5rem] border border-amber-100 bg-stone-50/80 p-3 lg:p-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="px-3 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-xs font-black">
            {selectedStudentLabel}
          </span>
          <span className="px-3 py-1 rounded-full bg-white border border-stone-200 text-stone-500 text-xs font-black">
            {selectedSeatLabel}
          </span>
        </div>
        <div className="mx-auto mb-4 w-full max-w-[260px] rounded-xl border-[6px] border-[#8b5a2b] bg-[#355c52] py-2 text-center shadow-[0_4px_0_#6d4520,0_12px_20px_-12px_rgba(0,0,0,0.35)]">
          <span className="font-jua text-sm tracking-[0.28em] text-white/90 ml-[0.28em]">칠판</span>
        </div>
        <div className="overflow-x-auto pb-1">
          <div
            className="grid gap-2.5 min-w-max mx-auto"
            style={{ gridTemplateColumns: `repeat(${seatLayoutMeta.displayedCols.length}, 76px)` }}
          >
            {seatLayoutMeta.displayedRows.flatMap((rowValue) => seatLayoutMeta.displayedCols.map((colValue) => {
              const seatKey = `${rowValue},${colValue}`;
              if (!seatLayoutMeta.seatKeySet.has(seatKey)) {
                return <div key={`blank-${seatKey}`} className="aspect-[1.25/1] opacity-0 pointer-events-none" />;
              }

              const assignedRule = fixedSeatRuleBySeatKey.get(seatKey);
              const isSelected = rule.seatKey === seatKey;
              const assignedToOtherRule = assignedRule !== undefined && assignedRule.id !== rule.id;
              const occupiedLabel = assignedToOtherRule
                ? (labelByStudentId.get(assignedRule.studentId) || '다른 학생')
                : '선택 가능';

              return (
                <button
                  key={seatKey}
                  type="button"
                  onClick={() => {
                    if (assignedToOtherRule) return;
                    updateFixedSeatRule(rule.id, 'seatKey', seatKey);
                  }}
                  disabled={assignedToOtherRule}
                  className={`relative aspect-[1.25/1] transition-all ${
                    assignedToOtherRule
                      ? 'cursor-not-allowed opacity-75'
                      : 'hover:-translate-y-1 active:translate-y-0'
                  } ${isSelected ? 'scale-[1.03]' : ''}`}
                >
                  <div className={`absolute inset-0 rounded-[1rem] border-t border-[#ffe4b5] overflow-hidden shadow-[0_4px_0_#d6b076,0_12px_18px_-12px_rgba(0,0,0,0.35)] ${
                    isSelected
                      ? 'bg-amber-200'
                      : assignedToOtherRule
                        ? 'bg-stone-300'
                        : 'bg-[#f3d09a]'
                  }`}>
                    <div className="absolute inset-0 opacity-10 bg-[linear-gradient(45deg,transparent_25%,#000_25%,#000_50%,transparent_50%,transparent_75%,#000_75%,#000_100%)] [background-size:4px_4px]"></div>
                    <div className={`absolute inset-[10%] rounded-[0.85rem] border flex flex-col items-center justify-center px-1.5 text-center ${
                      isSelected
                        ? 'bg-amber-50 border-amber-200 ring-2 ring-amber-400'
                        : assignedToOtherRule
                          ? 'bg-stone-100 border-stone-200'
                          : 'bg-white border-stone-100'
                    }`}>
                      <span className="text-[10px] font-black text-stone-400 leading-none">
                        {seatLayoutMeta.seatLabelByKey.get(seatKey) || seatKey}
                      </span>
                      <span className={`font-jua text-xs leading-tight mt-1 w-full truncate ${
                        isSelected
                          ? 'text-amber-700'
                          : assignedToOtherRule
                            ? 'text-stone-500'
                            : 'text-stone-700'
                      }`}>
                        {isSelected ? selectedStudentLabel : occupiedLabel}
                      </span>
                    </div>
                  </div>
                </button>
              );
            }))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-4 text-[11px] font-black text-stone-500">
          <span className="px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-700">선택한 자리</span>
          <span className="px-2.5 py-1 rounded-full bg-white border border-stone-200">선택 가능</span>
          <span className="px-2.5 py-1 rounded-full bg-stone-100 border border-stone-200 text-stone-500">다른 고정 자리</span>
        </div>
      </div>
    );
  };

  return (
    <div className="w-full max-w-5xl px-4 lg:px-8 pb-16 flex flex-col gap-6 lg:gap-8 animate-in fade-in duration-500">
      <div className="flex flex-col lg:flex-row items-center justify-between border-2 border-amber-100 rounded-[2rem] lg:rounded-[2.5rem] p-6 lg:p-8 bg-white shadow-xl shadow-amber-50/50 gap-6">
        <div className="flex items-center gap-4 lg:gap-6 w-full lg:w-auto">
          <div className="bg-amber-50 p-3 lg:p-4 rounded-3xl border border-amber-100 text-amber-500">
            <Sparkles className="w-6 h-6 lg:w-8 lg:h-8" />
          </div>
          <div>
            <h2 className="text-2xl lg:text-3xl font-black text-stone-800 leading-none mb-1 lg:mb-2 font-jua">자리 섞기 설정</h2>
            <p className="text-stone-500 text-xs lg:text-base font-medium">자리 섞기 옵션</p>
          </div>
        </div>
      </div>

      <section className="rounded-2xl border-2 border-stone-200 bg-white p-6 lg:p-7">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="font-black text-stone-800 text-lg lg:text-xl font-jua">성별 균형</h3>
            <p className="text-xs lg:text-sm text-stone-500">남녀 짝 배치 우선</p>
          </div>
          <button
            onClick={() => applySettingsChange({ ...settings, genderBalance: !settings.genderBalance })}
            className={`px-4 lg:px-5 py-2 rounded-xl font-black text-sm lg:text-base transition-all border-2 ${settings.genderBalance ? 'bg-emerald-50 border-emerald-300 text-emerald-600' : 'bg-white border-stone-200 text-stone-500'}`}
          >
            {settings.genderBalance ? 'ON' : 'OFF'}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border-2 border-stone-200 bg-white p-6 lg:p-7">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="font-black text-stone-800 text-lg lg:text-xl font-jua">중복 방지</h3>
            <p className="text-xs lg:text-sm text-stone-500">이전 자리와 저장된 배치/짝 중복 피하기</p>
          </div>
          <button
            onClick={() => applySettingsChange({ ...settings, avoidDuplicate: !settings.avoidDuplicate })}
            className={`px-4 lg:px-5 py-2 rounded-xl font-black text-sm lg:text-base transition-all border-2 ${settings.avoidDuplicate ? 'bg-emerald-50 border-emerald-300 text-emerald-600' : 'bg-white border-stone-200 text-stone-500'}`}
          >
            {settings.avoidDuplicate ? 'ON' : 'OFF'}
          </button>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4 lg:gap-5">
        <div className="rounded-2xl border-2 border-stone-200 bg-white p-5 lg:p-6 flex flex-col gap-4 xl:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-black text-stone-800 text-lg lg:text-xl font-jua">자리 고정</h3>
              <p className="text-xs lg:text-sm text-stone-500">특정 학생을 원하는 좌석에 고정</p>
            </div>
            <button
              onClick={addFixedSeatRule}
              disabled={!canAddFixedSeatRule}
              className={`px-4 py-2 rounded-xl border-2 font-black text-sm transition-all ${
                canAddFixedSeatRule
                  ? 'border-amber-300 bg-amber-50 text-amber-600 hover:bg-amber-100'
                  : 'border-stone-200 bg-stone-100 text-stone-400 cursor-not-allowed'
              }`}
            >
              추가
            </button>
          </div>
          {settings.fixedSeats.length === 0 ? (
            <div className="text-sm text-stone-400">고정 없음</div>
          ) : (
            <div className="space-y-3">
              {settings.fixedSeats.map((rule) => (
                <div key={rule.id} className="rounded-[1.75rem] border border-stone-200 bg-white p-4 lg:p-5 flex flex-col gap-4">
                  <div className="flex flex-col lg:flex-row gap-2 lg:items-center">
                    <select
                      value={rule.studentId}
                      onChange={(e) => updateFixedSeatRule(rule.id, 'studentId', e.target.value)}
                      className="w-full lg:max-w-xs border-2 border-stone-200 rounded-xl px-3 py-3 bg-white font-bold text-stone-700"
                    >
                      <option value="">학생</option>
                      {studentOptions
                        .filter((option) => option.id === rule.studentId || !settings.fixedSeats.some((otherRule) => otherRule.id !== rule.id && otherRule.studentId === option.id))
                        .map((option) => <option key={`${rule.id}-${option.id}-student`} value={option.id}>{option.label}</option>)}
                    </select>
                    <div className="flex items-center gap-2 lg:ml-auto">
                      <span className="px-3 py-2 rounded-xl border border-stone-200 bg-stone-50 text-xs font-black text-stone-500">
                        {seatLayoutMeta.seatLabelByKey.get(rule.seatKey) || '자리 선택'}
                      </span>
                      <button
                        onClick={() => removeFixedSeatRule(rule.id)}
                        className="h-12 px-4 rounded-xl border-2 border-rose-200 text-rose-500 hover:bg-rose-50"
                      >
                        <span className="sr-only">규칙 삭제</span>
                        X
                      </button>
                    </div>
                  </div>
                  {renderFixedSeatMap(rule)}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border-2 border-stone-200 bg-white p-5 lg:p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-black text-stone-800 text-lg lg:text-xl font-jua">같이 앉으면 안됨</h3>
              <p className="text-xs lg:text-sm text-stone-500">짝 배치 금지</p>
            </div>
            <button
              onClick={addForbiddenPairRule}
              className="px-4 py-2 rounded-xl border-2 border-amber-300 bg-amber-50 text-amber-600 font-black text-sm hover:bg-amber-100"
            >
              추가
            </button>
          </div>
          {settings.forbiddenPairs.length === 0 ? (
            <div className="text-sm text-stone-400">규칙 없음</div>
          ) : (
            <div className="space-y-3">
              {settings.forbiddenPairs.map((rule) => (
                <div key={rule.id} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                  <select
                    value={rule.firstStudentId}
                    onChange={(e) => updateForbiddenPairRule(rule.id, 'firstStudentId', e.target.value)}
                    className="w-full border-2 border-stone-200 rounded-xl px-3 py-3 bg-white font-bold text-stone-700"
                  >
                    <option value="">학생</option>
                    {studentOptions
                      .filter((option) => option.id !== rule.secondStudentId)
                      .map((option) => <option key={`${rule.id}-${option.id}-a`} value={option.id}>{option.label}</option>)}
                  </select>
                  <select
                    value={rule.secondStudentId}
                    onChange={(e) => updateForbiddenPairRule(rule.id, 'secondStudentId', e.target.value)}
                    className="w-full border-2 border-stone-200 rounded-xl px-3 py-3 bg-white font-bold text-stone-700"
                  >
                    <option value="">학생</option>
                    {studentOptions
                      .filter((option) => option.id !== rule.firstStudentId)
                      .map((option) => <option key={`${rule.id}-${option.id}-b`} value={option.id}>{option.label}</option>)}
                  </select>
                  <button
                    onClick={() => removeForbiddenPairRule(rule.id)}
                    className="h-12 px-4 rounded-xl border-2 border-rose-200 text-rose-500 hover:bg-rose-50"
                  >
                    <span className="sr-only">규칙 삭제</span>
                    X
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border-2 border-stone-200 bg-white p-5 lg:p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-black text-stone-800 text-lg lg:text-xl font-jua">모여있으면 안됨</h3>
              <p className="text-xs lg:text-sm text-stone-500">상하좌우 인접 금지</p>
            </div>
            <button
              onClick={addForbiddenGroupRule}
              className="px-4 py-2 rounded-xl border-2 border-amber-300 bg-amber-50 text-amber-600 font-black text-sm hover:bg-amber-100"
            >
              추가
            </button>
          </div>
          {settings.forbiddenGroups.length === 0 ? (
            <div className="text-sm text-stone-400">규칙 없음</div>
          ) : (
            <div className="space-y-3">
              {settings.forbiddenGroups.map((rule) => (
                <div key={rule.id} className="rounded-2xl border border-stone-200 bg-stone-50 p-3 flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <select
                      value=""
                      onChange={(e) => addNameToGroupRule(rule.id, e.target.value)}
                      className="w-full max-w-xs border-2 border-stone-200 rounded-xl px-3 py-2.5 bg-white font-bold text-stone-700"
                    >
                      <option value="">학생 추가</option>
                      {studentOptions
                        .filter((option) => !rule.studentIds.includes(option.id))
                        .map((option) => <option key={`${rule.id}-${option.id}`} value={option.id}>{option.label}</option>)}
                    </select>
                    <button
                      onClick={() => removeForbiddenGroupRule(rule.id)}
                      className="h-11 px-4 rounded-xl border-2 border-rose-200 text-rose-500 hover:bg-rose-50"
                    >
                      <span className="sr-only">규칙 삭제</span>
                      X
                    </button>
                  </div>
                  {renderNameChips(rule.studentIds, (studentId) => removeNameFromGroupRule(rule.id, studentId), 'bg-white border-stone-200 text-stone-700 hover:border-rose-300')}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border-2 border-stone-200 bg-white p-5 lg:p-6 flex flex-col gap-4">
          <div>
            <h3 className="font-black text-stone-800 text-lg lg:text-xl font-jua">맨 앞만</h3>
            <p className="text-xs lg:text-sm text-stone-500">첫 줄만 허용</p>
          </div>
          <select
            value=""
            onChange={(e) => addNameToListRule('frontOnly', e.target.value)}
            className="w-full max-w-xs border-2 border-stone-200 rounded-xl px-3 py-2.5 bg-white font-bold text-stone-700"
          >
            <option value="">학생 추가</option>
            {studentOptions
              .filter((option) => !settings.frontOnly.includes(option.id))
              .map((option) => <option key={`front-${option.id}`} value={option.id}>{option.label}</option>)}
          </select>
          {renderNameChips(settings.frontOnly, (studentId) => removeNameFromListRule('frontOnly', studentId), 'bg-amber-50 border-amber-200 text-amber-700 hover:border-amber-300')}
        </div>

        <div className="rounded-2xl border-2 border-stone-200 bg-white p-5 lg:p-6 flex flex-col gap-4">
          <div>
            <h3 className="font-black text-stone-800 text-lg lg:text-xl font-jua">맨 뒤 금지</h3>
            <p className="text-xs lg:text-sm text-stone-500">마지막 줄 제외</p>
          </div>
          <select
            value=""
            onChange={(e) => addNameToListRule('noBackRow', e.target.value)}
            className="w-full max-w-xs border-2 border-stone-200 rounded-xl px-3 py-2.5 bg-white font-bold text-stone-700"
          >
            <option value="">학생 추가</option>
            {studentOptions
              .filter((option) => !settings.noBackRow.includes(option.id))
              .map((option) => <option key={`back-${option.id}`} value={option.id}>{option.label}</option>)}
          </select>
          {renderNameChips(settings.noBackRow, (studentId) => removeNameFromListRule('noBackRow', studentId), 'bg-sky-50 border-sky-200 text-sky-700 hover:border-sky-300')}
        </div>

        <div className="rounded-2xl border-2 border-stone-200 bg-white p-5 lg:p-6 flex flex-col gap-4 xl:col-span-2">
          <div>
            <h3 className="font-black text-stone-800 text-lg lg:text-xl font-jua">혼자 앉기 금지</h3>
            <p className="text-xs lg:text-sm text-stone-500">좌우 중 한 자리 이상 이웃 필요</p>
          </div>
          <select
            value=""
            onChange={(e) => addNameToListRule('noSoloSeat', e.target.value)}
            className="w-full max-w-xs border-2 border-stone-200 rounded-xl px-3 py-2.5 bg-white font-bold text-stone-700"
          >
            <option value="">학생 추가</option>
            {studentOptions
              .filter((option) => !settings.noSoloSeat.includes(option.id))
              .map((option) => <option key={`solo-${option.id}`} value={option.id}>{option.label}</option>)}
          </select>
          {renderNameChips(settings.noSoloSeat, (studentId) => removeNameFromListRule('noSoloSeat', studentId), 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:border-emerald-300')}
        </div>
      </section>
    </div>
  );
};

export default App;
