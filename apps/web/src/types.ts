export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarColor: number;
  bio: string;
}

export interface ServerSummary {
  id: string;
  name: string;
  ownerId: string;
  iconColor: number;
  hasPassword: boolean;
  role: string;
  memberCount: number;
  online?: string[];
  onlineCount?: number;
}

export interface Member {
  id: string;
  username: string;
  displayName: string;
  avatarColor: number;
  role: string;
}

export interface ServerDetail {
  id: string;
  name: string;
  ownerId: string;
  iconColor: number;
  hasPassword: boolean;
  memberCount: number;
  myRole: string;
}

export interface InvitePreview {
  server: { id: string; name: string; iconColor: number; memberCount: number; hasPassword: boolean };
  requiresPassword: boolean;
}

export type ToastKind = 'ok' | 'warn' | 'err' | 'info';
export interface Toast { id: number; text: string; kind: ToastKind }

export interface ChatMessage {
  id: number;
  who: string | null; // null = system
  text: string;
  mine: boolean;
  sys: boolean;
  color?: number; // avatar color index of author
}

export interface HistoryMessage {
  uid: string;
  name: string;
  color: number;
  text: string;
  em: Record<string, string>;
  ts: number;
}

export interface Emote { id: string; name: string }

export type Presence = 'voice' | 'online' | 'offline';

export interface AudioSettings {
  input: string;
  output: string;
  ns: boolean;
  ec: boolean;
  agc: boolean;
  mode: 'voice' | 'ptt';
  pttKey: string;
  master: number;
  micVolume: number; // громкость микрофона в %, 100 = без изменений
}
