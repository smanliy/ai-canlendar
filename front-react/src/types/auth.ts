export interface User {
  id: string;
  nickname: string;
  phone: string;
  email?: string;
  avatarUrl?: string;
}

export interface LoginPayload {
  phone: string;
  code: string;
}

export interface RegisterPayload extends LoginPayload {
  nickname: string;
}

export interface SmsCodePayload {
  phone: string;
  scene: 'login' | 'register';
}

export interface SmsCodeResult {
  expiresIn: number;
  cooldown: number;
  mockCode?: string;
}

export interface AuthResult {
  user: User;
  token: string;
  csrfToken: string;
  expiresAt: string;
}
