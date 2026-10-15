import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession } from 'mongodb';
import { Connection, Types } from 'mongoose';
import { Models, getModels } from '../models';

export interface AuditEntry {
  organizationId?: Types.ObjectId | null;
  propertyId?: Types.ObjectId | null;
  userId?: Types.ObjectId | null;
  action: string;
  entityType: string;
  entityId: Types.ObjectId;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly m: Models;

  constructor(@InjectConnection() connection: Connection) {
    this.m = getModels(connection);
  }

  /** Pass the session to make the audit row commit or roll back with the change it describes. */
  async record(session: ClientSession | null, entry: AuditEntry): Promise<void> {
    await this.m.AuditLog.create([{ ...entry, metadata: entry.metadata ?? {} }], { session });
  }
}
