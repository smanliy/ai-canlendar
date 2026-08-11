export interface SendCodeDto {
  phone: string;
  scene: 'login' | 'register';
}

export interface LoginDto {
  phone: string;
  code: string;
}

export interface RegisterDto {
  phone: string;
  code: string;
  nickname: string;
}