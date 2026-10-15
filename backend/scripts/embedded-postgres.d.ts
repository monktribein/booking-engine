// embedded-postgres is ESM-only and ships types that classic ("node") module resolution cannot find.
// Only the small surface used by scripts/embedded-pg.ts is declared.
declare module 'embedded-postgres' {
  export interface EmbeddedPostgresOptions {
    databaseDir: string;
    port: number;
    user: string;
    password: string;
    persistent: boolean;
    initdbFlags: string[];
    onLog: (message: unknown) => void;
    onError: (message: unknown) => void;
  }
  export default class EmbeddedPostgres {
    constructor(options?: Partial<EmbeddedPostgresOptions>);
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
  }
}
