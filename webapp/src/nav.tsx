import { createContext, useContext } from 'react';
import type { Me } from './api';

export type Route =
  | { name: 'search' }
  | { name: 'vacancy'; id: number }
  | { name: 'letter'; vacancyId: number }
  | { name: 'favorites' }
  | { name: 'profile' }
  | { name: 'resume' }
  | { name: 'history' }
  | { name: 'subscription'; limit?: { resetAt: string; limit: number }; paymentId?: number }
  | { name: 'support' };

export const TABS = ['search', 'favorites', 'profile'] as const;

export interface Nav {
  route: Route;
  push(r: Route): void;
  back(): void;
  tab(name: (typeof TABS)[number]): void;
  me: Me | null;
  refreshMe(): void;
}

export const NavContext = createContext<Nav>(null!);
export const useNav = () => useContext(NavContext);

/** start_param → стартовый стек экранов. */
export function routeFromStart(p?: string): Route[] {
  if (!p) return [{ name: 'search' }];
  const [kind, id] = p.split('_');
  const n = Number(id);
  switch (kind) {
    case 'vacancy': return n ? [{ name: 'search' }, { name: 'vacancy', id: n }] : [{ name: 'search' }];
    case 'letter': return n ? [{ name: 'search' }, { name: 'vacancy', id: n }, { name: 'letter', vacancyId: n }] : [{ name: 'search' }];
    case 'paid':
    case 'payfail': return [{ name: 'profile' }, { name: 'subscription', paymentId: n || undefined }];
    case 'subscription': return [{ name: 'profile' }, { name: 'subscription' }];
    case 'support': return [{ name: 'profile' }, { name: 'support' }];
    case 'favorites': return [{ name: 'favorites' }];
    default: return [{ name: 'search' }];
  }
}
