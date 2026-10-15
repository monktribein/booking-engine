'use client';

import React from 'react';
import { useAuth } from './auth-context';
import { UserRole } from '@/types';

interface RoleGuardProps {
  roles: UserRole[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export function RoleGuard({ roles, children, fallback = null }: RoleGuardProps) {
  const { hasRole, isLoading } = useAuth();

  if (isLoading) return null;
  if (!hasRole(roles)) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
