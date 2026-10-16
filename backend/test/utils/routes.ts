import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import 'reflect-metadata';

export interface RouteInfo {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Full path with `:param` placeholders, e.g. /properties/:id/rooms */
  path: string;
  params: string[];
  /** @Public(): no JWT needed (public site, webhooks, login). */
  isPublic: boolean;
  controller: string;
}

// RequestMethod enum values of @nestjs/common
const METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;

const join = (...parts: (string | string[] | undefined)[]) =>
  '/' +
  parts
    .flatMap((p) => (Array.isArray(p) ? p[0] ?? '' : p ?? ''))
    .join('/')
    .split('/')
    .filter(Boolean)
    .join('/');

/** Every HTTP route of the running app, read from the controllers' metadata (the same data Nest routes with). */
export function listRoutes(app: INestApplication): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const controllers = [...app.get(ModulesContainer).values()].flatMap((m) => [...m.controllers.values()]);
  for (const wrapper of controllers) {
    const cls = wrapper.metatype as (new (...a: never[]) => unknown) | null;
    if (!cls) continue;
    const base = Reflect.getMetadata('path', cls) as string | string[] | undefined;
    const classPublic = !!Reflect.getMetadata('tirvona:isPublic', cls);
    for (const name of Object.getOwnPropertyNames(cls.prototype)) {
      const handler = (cls.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata('method', handler) as number | undefined;
      if (method === undefined || !METHODS[method]) continue; // ALL / OPTIONS / HEAD are not used by this app
      const sub = Reflect.getMetadata('path', handler) as string | string[] | undefined;
      const path = join(base, sub);
      routes.push({
        method: METHODS[method],
        path,
        params: [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]),
        isPublic: classPublic || !!Reflect.getMetadata('tirvona:isPublic', handler),
        controller: cls.name,
      });
    }
  }
  return routes;
}
