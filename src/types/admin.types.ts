export interface CreateAdminInput {
  name: string;
  email: string;
  password: string;
}

// Never includes passwordHash -- this is the shape returned to API clients.
export interface SafeAdminUser {
  id: string;
  name: string;
  email: string;
  role: "ADMIN";
  isActive: boolean;
  createdAt: Date;
}
