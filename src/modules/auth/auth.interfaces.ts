export interface JwtPayload {
  id: string;
  email: string;
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
  createdAt: Date;
}

export interface AuthResult {
  token: string;
  user: AuthUser;
}