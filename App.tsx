import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Settings as SettingsIcon, HomeIcon, RefreshCw, Trash2, PlusCircle, Sparkles, Layers, Move, Eraser, Info, Users, ChevronUp, ChevronDown, Camera, Save, History, X, Play, Maximize2, AlertCircle, Type, Smile } from 'lucide-react';
import { ClassroomConfig, ViewType, Seat, EditModeType, Student, Gender, Position, HistoryItem } from './types';
import { audioService } from './services/audioService';
import * as htmlToImage from 'html-to-image';

const DEFAULT_STUDENTS: Student[] = Array.from({ length: 22 }, (_, i) => ({
  name: `학생${i + 1}`,
  gender: 'M'
}));

const GROUP_COLORS = [
  'bg-white border-stone-200', 
  'bg-rose-50 border-rose-200',
  'bg-blue-50 border-blue-200',
  'bg-emerald-50 border-emerald-200',
  'bg-amber-50 border-amber-200',
  'bg-violet-50 border-violet-200',
  'bg-cyan-50 border-cyan-200',
  'bg-orange-50 border-orange-200',
  'bg-indigo-50 border-indigo-200',
];

const GROUP_BADGE_COLORS = [
  'bg-stone-400',
  'bg-rose-500',
  'bg-blue-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-cyan-500',
  'bg-orange-500',
  'bg-indigo-500',
];

const App: React.FC = () => {
  const [view, setView] = useState<ViewType>('layout');
  const [editMode, setEditMode] = useState<EditModeType>('none');
  const [selectedGroupId, setSelectedGroupId] = useState<number>(1);
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
  
  // SettingsView 상태를 App으로 끌어올림
  const [editingStudents, setEditingStudents] = useState<Student[]>([]);

  const STORAGE_KEY = 'classroom_history_v18';
  const CONFIG_KEY = 'classroom_config_v18';

  const [history, setHistory] = useState<HistoryItem[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  });
  
  const [config, setConfig] = useState<ClassroomConfig>(() => {
    const saved = localStorage.getItem(CONFIG_KEY);
    if (saved) { 
      try { 
        return JSON.parse(saved) as ClassroomConfig; 
      } catch (e) { console.error(e); } 
    }
    const cols = 6;
    const positions = DEFAULT_STUDENTS.map((_, i) => ({ r: Math.floor(i / cols), c: i % cols }));
    return { students: DEFAULT_STUDENTS, positions, groupMap: {} };
  });
  
  const [displayStudents, setDisplayStudents] = useState<Student[]>(config.students);
  const countdownTimerRef = useRef<number | null>(null);
  const countdownPollTimerRef = useRef<number | null>(null);
  const countdownEndTimeRef = useRef<number | null>(null);
  const shuffleStartLockRef = useRef(false);
  const shuffleIntervalRef = useRef<number | null>(null);
  const movementIntervalRef = useRef<number | null>(null);
  const layoutContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }, [config]);

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
    countdownEndTimeRef.current = null;
  };

  const handleShuffleStart = useCallback(() => {
    if (shuffleStartLockRef.current || isShuffling || countdown !== null) return;
    shuffleStartLockRef.current = true;
    
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
    countdownEndTimeRef.current = Date.now() + 5000;
    let hasFinalized = false;

    const finalizeShuffle = () => {
      if (hasFinalized) return;
      hasFinalized = true;
      shuffleStartLockRef.current = false;
      stopAllTimers();
      const shuffledPositions = [...currentPositions].sort(() => Math.random() - 0.5);
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

    countdownTimerRef.current = window.setInterval(() => {
      setCountdown(prev => {
        if (prev === null) return null;
        if (prev <= 1) {
          finalizeShuffle();
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
        finalizeShuffle();
        return;
      }
      setCountdown(prev => (prev === null || prev === remaining ? prev : remaining));
    }, 250);

    // 모바일 성능을 위해 업데이트 주기를 150ms -> 200ms로 조정
    shuffleIntervalRef.current = window.setInterval(() => {
      setDisplayStudents(prev => [...prev].sort(() => Math.random() - 0.5));
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
  }, [config.students, config.positions, isShuffling, countdown, isCoarsePointerDevice]);

  useEffect(() => {
    return () => {
      stopAllTimers();
    };
  }, []);

  const handleCapture = async () => {
    if (!layoutContainerRef.current || isCapturing) return;

    const targetElement = (layoutContainerRef.current.querySelector('.layout-content') as HTMLElement | null) ?? layoutContainerRef.current;
    if (!targetElement) return;

    const isMobileCapture = isCoarsePointerDevice || window.innerWidth < 1024;
    const pixelRatio = isMobileCapture ? 1 : Math.min(1.5, window.devicePixelRatio || 1);
    const paddingX = isMobileCapture ? 12 : 40;
    const paddingY = isMobileCapture ? 12 : 28;
    const fileName = `seating_${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    let captureRoot: HTMLDivElement | null = null;

    try {
      setIsCapturing(true);
      audioService.playCapture();
      const clonedLayout = targetElement.cloneNode(true) as HTMLElement;
      clonedLayout.style.transform = 'none';
      clonedLayout.style.transition = 'none';
      clonedLayout.style.animation = 'none';
      clonedLayout.style.margin = '0';

      captureRoot = document.createElement('div');
      captureRoot.style.position = 'fixed';
      captureRoot.style.left = '-100000px';
      captureRoot.style.top = '0';
      captureRoot.style.pointerEvents = 'none';
      captureRoot.style.opacity = '0';
      captureRoot.style.zIndex = '-1';
      captureRoot.style.display = 'inline-block';
      captureRoot.style.background = '#fdfbf7';
      captureRoot.style.padding = `${paddingY}px ${paddingX}px`;
      captureRoot.appendChild(clonedLayout);
      document.body.appendChild(captureRoot);
      if (!captureRoot) return;
      const options = {
        backgroundColor: '#fdfbf7',
        pixelRatio,
        type: 'image/jpeg',
        quality: isMobileCapture ? 0.82 : 0.9,
        skipFonts: isMobileCapture,
        skipAutoScale: isMobileCapture,
        style: {
          animation: 'none',
          transition: 'none',
        },
      } as const;
      let blob = await htmlToImage.toBlob(captureRoot, options);
      if (!blob) {
        const fallbackDataUrl = await htmlToImage.toJpeg(captureRoot, options);
        setExpandedImage(fallbackDataUrl);
        return;
      }
      const nav = navigator as Navigator & {
        canShare?: (data: { files: File[] }) => boolean;
      };

      if (isMobileCapture && nav.share) {
        const file = new File([blob], fileName, { type: 'image/jpeg' });
        if (!nav.canShare || nav.canShare({ files: [file] })) {
          await nav.share({ files: [file], title: '자리 배치 캡쳐' });
          return;
        }
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
      alert('이미지 캡쳐에 실패했습니다. 다시 시도해 주세요.');
    }
    finally {
      if (captureRoot && captureRoot.parentNode) {
        captureRoot.parentNode.removeChild(captureRoot);
      }
      setIsCapturing(false);
    }
  };

  const triggerSaveModal = () => {
    setNewRecordTitle(`${new Date().getMonth() + 1}월 ${new Date().getDate()}일 자리 배치`);
    setIsSaveModalOpen(true);
    audioService.playClick();
  };

  const handleSaveToHistory = async () => {
    setIsSaveModalOpen(false);
    const contentElement = layoutContainerRef.current?.querySelector('.layout-content') as HTMLElement;
    
    if (!contentElement) return;

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
        title: newRecordTitle.trim() || `${new Date().toLocaleDateString()} 배치`,
        config: JSON.parse(JSON.stringify(config)),
        thumbnail,
      };
      setHistory(prev => [newItem, ...prev]);
      setNewRecordTitle('');
    } catch (e) {
      console.error("Save failed:", e);
      const newItem: HistoryItem = { 
        id: crypto.randomUUID(), 
        date: new Date().toLocaleString(), 
        title: newRecordTitle.trim() || `${new Date().toLocaleDateString()} 배치`,
        config: JSON.parse(JSON.stringify(config)) 
      };
      setHistory(prev => [newItem, ...prev]);
      alert('이미지 생성에 실패하여 텍스트 데이터만 저장되었습니다.');
    }
  };

  const handleConfirmAction = () => {
    if (!confirmAction) return;
    const { type, item } = confirmAction;
    
    if (type === 'delete') {
      setHistory(prev => prev.filter(i => i.id !== item.id));
      audioService.playClick();
    } else {
      setConfig(item.config);
      setDisplayStudents(item.config.students);
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

      return { ...prev, positions: newPositions, groupMap: newGroupMap };
    });
  };

  const handleEnterSettings = () => {
    audioService.playClick();
    setEditingStudents(JSON.parse(JSON.stringify(config.students)));
    setView('settings');
    setEditMode('none');
  };

  const handleSaveAndExitSettings = () => {
    audioService.playSave();
    handleUpdateConfig(editingStudents);
  };

  const handleUpdateConfig = (newStudents: Student[]) => {
    setConfig(prev => {
      const cols = 6;
      const positions = newStudents.length === prev.students.length 
        ? prev.positions 
        : newStudents.map((_, i) => ({ r: Math.floor(i / cols), c: i % cols }));
      
      const groupMap = newStudents.length === prev.students.length ? prev.groupMap : {};

      return { students: newStudents, positions, groupMap };
    });
    setEditMode('none');
    setView('layout');
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
        result.push({ r, c, isActive, student: isActive ? displayStudents[studentIdx] : null, groupId: config.groupMap[`${r},${c}`] || 0 });
      }
    }
    return result;
  }, [visibleRange, config.positions, displayStudents, config.groupMap]);

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
              <p className="text-stone-500 font-medium text-sm">나중에 기억하기 쉬운 멋진 이름을 지어주세요!</p>
            </div>
            
            <div className="relative">
              <input 
                autoFocus
                type="text"
                maxLength={30}
                value={newRecordTitle}
                onChange={e => setNewRecordTitle(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSaveToHistory()}
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
                onClick={handleSaveToHistory}
                disabled={!newRecordTitle.trim()}
                className="flex-1 py-3.5 rounded-xl font-black text-white bg-amber-500 shadow-[0_4px_0_#b45309] hover:translate-y-[2px] hover:shadow-[0_2px_0_#b45309] active:translate-y-[4px] active:shadow-none transition-all disabled:bg-stone-200 disabled:shadow-none font-jua text-lg"
              >
                저장하기
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
              <SettingsIcon size={18} /> <span className="font-jua text-sm lg:text-lg pt-0.5 hidden sm:inline">명단 관리</span>
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
                <button 
                  onClick={handleCapture}
                  disabled={isCapturing}
                  className="flex flex-col lg:flex-row items-center justify-center lg:justify-start gap-1 lg:gap-3 w-full p-2 lg:p-3.5 rounded-xl lg:rounded-2xl bg-stone-50 border border-stone-100 hover:border-amber-200 hover:bg-amber-50/50 transition-all text-stone-600 group"
                >
                  <div className="bg-white p-1.5 lg:p-2.5 rounded-lg lg:rounded-xl shadow-sm border border-stone-100 group-hover:border-amber-100 group-hover:text-amber-600 transition-colors"><Camera size={18} /></div>
                  <span className="font-bold text-[10px] lg:text-base font-jua pt-0.5">이미지 캡쳐</span>
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
                  editMode={editMode}
                  onSeatClick={handleSeatInteraction}
                  isShuffling={isShuffling}
                  shufflingOffsets={shufflingOffsets}
                  onMove={handleSeatMove}
                  selectedSeat={selectedSeat}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="w-full flex flex-col items-center bg-[#fdfbf7] overflow-y-auto custom-scrollbar pt-6 lg:pt-10 pb-20">
            <SettingsView students={editingStudents} onChange={setEditingStudents} />
          </div>
        )}
      </main>
    </div>
  );
};

interface LayoutViewProps {
  seats: Seat[];
  range: { startR: number, endR: number, startC: number, endC: number };
  editMode: EditModeType;
  onSeatClick: (r: number, c: number) => void;
  isShuffling: boolean;
  shufflingOffsets: Record<string, { x: number, y: number }>;
  onMove: (from: {r: number, c: number}, to: {r: number, c: number}) => void;
  selectedSeat: {r: number, c: number} | null;
}

const LayoutView: React.FC<LayoutViewProps> = ({ seats, range, editMode, onSeatClick, isShuffling, shufflingOffsets, onMove, selectedSeat }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [dragOverPos, setDragOverPos] = useState<string | null>(null);

  const cols = range.endC - range.startC + 1;

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
        {/* 칠판 영역 */}
        <div className={`w-full max-w-[500px] mb-14 flex flex-col items-center transition-opacity ${isShuffling ? 'opacity-20' : ''}`}>
          <div className="w-full h-28 rounded-xl border-[8px] border-[#8b5a2b] shadow-2xl flex items-center justify-center relative chalkboard-texture overflow-hidden">
             {/* 분필 가루 효과 */}
             <div className="absolute top-1/2 left-1/4 w-32 h-20 bg-white/5 blur-xl rounded-full rotate-12"></div>
             <div className="absolute inset-x-0 -bottom-3 h-3 bg-[#6d4520] rounded-b-lg shadow-md mx-1"></div>
             <span className="text-white/90 text-4xl font-jua tracking-[0.3em] ml-[0.3em] select-none drop-shadow-md">칠 판</span>
             <div className="absolute bottom-2 right-4 w-12 h-3 bg-stone-200/20 rounded-sm rotate-1 backdrop-blur-[1px]"></div>
          </div>
        </div>

        <div className="seating-grid grid gap-x-6 gap-y-10 transition-all duration-500" style={{ gridTemplateColumns: `repeat(${cols}, 120px)` }}>
          {seats.map((seat) => {
            const posKey = `${seat.r},${seat.c}`;
            const offset = shufflingOffsets[posKey] || { x: 0, y: 0 };
            const isOver = dragOverPos === posKey;
            // 선택된 좌석인지 확인
            const isSelected = selectedSeat?.r === seat.r && selectedSeat?.c === seat.c;
            
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
                  ${isSelected ? 'scale-110 z-50 ring-4 ring-amber-400 ring-offset-4 rounded-xl shadow-xl' : ''}
                `}
                style={isShuffling && seat.isActive ? {
                  transform: `translate(${offset.x}px, ${offset.y}px) rotate(${(offset.x + offset.y) * 0.08}deg)`,
                  transition: 'transform 0.4s ease-in-out'
                } : {}}
              >
                {seat.isActive && seat.student && (
                  <>
                    {/* 책상 디자인 (나무 질감) */}
                    <div className={`w-full h-full bg-[#f3d09a] rounded-lg shadow-[0_6px_0_#d6b076,0_15px_20px_-5px_rgba(0,0,0,0.15)] border-t-2 border-[#ffe4b5] relative overflow-hidden flex flex-col items-center justify-center p-2 group transition-transform
                      ${GROUP_COLORS[seat.groupId]} ${seat.groupId > 0 ? 'ring-2 ring-opacity-50' : ''}
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
        ...Array.from({ length: newCount - students.length }, (_, i) => ({
          name: `학생${students.length + i + 1}`,
          gender: 'M' as Gender
        }))
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

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 lg:gap-5 pb-12">
        {students.map((s, i) => (
          <div 
            key={i} 
            className="flex flex-col gap-2 lg:gap-3 p-4 lg:p-5 rounded-2xl lg:rounded-3xl border-2 border-stone-100 bg-white hover:border-amber-300 transition-all shadow-sm hover:shadow-[0_8px_16px_-4px_rgba(245,158,11,0.1)] group relative overflow-hidden"
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
              ><Trash2 className="w-4 h-4 lg:w-[18px] lg:h-[18px]" /></button>
            </div>
            
            <div className="flex gap-2 mt-1">
              <button 
                onClick={() => { audioService.playClick(); updateStudent(i, { gender: 'M' }); }} 
                className={`flex-1 py-1 lg:py-1.5 rounded-lg lg:rounded-xl text-xs lg:text-sm font-black transition-all border-2 font-jua ${s.gender === 'M' ? 'bg-blue-50 border-blue-200 text-blue-500' : 'bg-stone-50 border-stone-100 text-stone-300 hover:border-stone-200'}`}
              >남</button>
              <button 
                onClick={() => { audioService.playClick(); updateStudent(i, { gender: 'F' }); }} 
                className={`flex-1 py-1 lg:py-1.5 rounded-lg lg:rounded-xl text-xs lg:text-sm font-black transition-all border-2 font-jua ${s.gender === 'F' ? 'bg-rose-50 border-rose-200 text-rose-500' : 'bg-stone-50 border-stone-100 text-stone-300 hover:border-stone-200'}`}
              >여</button>
            </div>
          </div>
        ))}

        <button 
          onClick={() => { audioService.playClick(); handleCountChange(students.length + 1); }} 
          className="flex flex-col items-center justify-center gap-2 lg:gap-3 min-h-[120px] lg:min-h-[140px] rounded-2xl lg:rounded-3xl border-3 border-dashed border-stone-200 text-stone-400 font-bold hover:bg-stone-50 hover:border-amber-300 hover:text-amber-400 transition-all"
        >
          <div className="bg-white p-2 lg:p-3 rounded-full shadow-sm"><PlusCircle className="w-5 h-5 lg:w-6 lg:h-6" /></div>
          <span className="text-sm font-jua lg:text-lg">친구 추가하기</span>
        </button>
      </div>
      
    </div>
  );
};

export default App;
