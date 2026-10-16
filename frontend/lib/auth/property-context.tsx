'use client';

import React, { createContext, useCallback, useContext, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Property } from '@/types';
import { propertiesApi } from '../api';
import { UserRole } from '@/types';
import { useAuth } from './auth-context';

interface PropertyContextType {
  /** null until properties load, or when the account has none. Never a placeholder. */
  activeProperty: Property | null;
  properties: Property[];
  isLoading: boolean;
  error: Error | null;
  setActiveProperty: (property: Property) => void;
  reloadProperties: () => Promise<void>;
}

const PropertyContext = createContext<PropertyContextType | undefined>(undefined);

function savedPropertyId(): string | null {
  try {
    return typeof window === 'undefined' ? null : localStorage.getItem('tirvona_property_id');
  } catch {
    return null;
  }
}

export function PropertyProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading: authLoading, user } = useAuth();
  // Platform staff and developers have no property memberships: they never load (or show) a property list.
  const hasProperties = !!user && ![UserRole.SUPER_ADMIN, UserRole.OPERATIONS_ADMIN, UserRole.DEVELOPER].includes(user.role);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Public pages and the signed-out state make no authenticated call (enabled: false).
  const query = useQuery({
    queryKey: ['properties', 'mine'],
    queryFn: () => propertiesApi.list(),
    enabled: isAuthenticated && !authLoading && hasProperties,
  });

  const items = isAuthenticated ? (query.data?.items ?? []) : [];
  const active = items.find((p) => p._id === (selectedId ?? savedPropertyId())) ?? items[0] ?? null;

  const setActiveProperty = (prop: Property) => {
    setSelectedId(prop._id);
    try {
      localStorage.setItem('tirvona_property_id', prop._id);
    } catch {
      /* storage unavailable: the choice just won't survive a reload */
    }
  };

  const reloadProperties = useCallback(async () => {
    await query.refetch();
  }, [query]);

  return (
    <PropertyContext.Provider
      value={{
        // Signed out: nothing from a previous session is ever exposed.
        activeProperty: active,
        properties: items,
        isLoading: authLoading || (isAuthenticated && query.isLoading),
        error: isAuthenticated && query.isError ? (query.error as Error) : null,
        setActiveProperty,
        reloadProperties,
      }}
    >
      {children}
    </PropertyContext.Provider>
  );
}

export function useProperty() {
  const context = useContext(PropertyContext);
  if (!context) {
    throw new Error('useProperty must be used within a PropertyProvider');
  }
  return context;
}
