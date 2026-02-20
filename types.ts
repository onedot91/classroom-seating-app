
export type Gender = 'M' | 'F' | 'N';

export interface Student {
  name: string;
  gender: Gender;
}

export interface Position {
  r: number;
  c: number;
}

export interface ClassroomConfig {
  students: Student[];
  positions: Position[]; // Coordinates for each student desk
  groupMap: Record<string, number>; // "r,c" -> groupId
  pairMap: Record<string, number>; // "r,c" -> pairId
}

export interface StudentSnapshot {
  name: string;
  gender: Gender;
  seat: Position;
  pairId?: number;
  pairPartnerName?: string;
  pairPartnerSeat?: Position;
}

export interface HistoryItem {
  id: string;
  date: string;
  title?: string; // 기록의 제목 (사용자 입력)
  config: ClassroomConfig;
  studentSnapshots?: StudentSnapshot[];
  thumbnail?: string; // Base64 image string for preview
}

export type ViewType = 'layout' | 'settings';
export type EditModeType = 'none' | 'position' | 'group' | 'pair';

export interface Seat {
  r: number;
  c: number;
  student: Student | null;
  isActive: boolean;
  groupId: number;
  pairId?: number;
}
