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

export interface AuthResult {
  user: User;
  token: string;
  csrfToken: string;
  expiresAt: string;
}
