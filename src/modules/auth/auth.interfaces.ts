export interface JwtPayload {
  id: string;
  email: string;
  tokenVersion: number;
}

export interface RegisterUserInput {
  email: string;
  password: string;
}

export interface LoginUserInput {
  email: string;
  password: string;
}

export interface AuthUser {
  id: string;
  email: string;
  role: "USER" | "ADMIN";
  isVerified: boolean;
  storageUsed: number;
  storageLimit: number;
  createdAt: Date;
}

export interface AuthResult {
  token: string;
  refreshToken: string;
  user: AuthUser;
}

export interface RefreshResult {
  token: string;
  refreshToken: string;
}

export interface RefreshTokenInput {
  refreshToken: string;
}
