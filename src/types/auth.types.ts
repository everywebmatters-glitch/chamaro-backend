export type Role = "CUSTOMER" | "ADMIN";

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AdminLoginInput {
  email: string;
  password: string;
}

export interface GoogleIdentity {
  googleId: string;
  email: string;
  name: string;
}

// Never includes passwordHash -- this is the shape returned to API clients.
export interface SafeUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
}

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}
