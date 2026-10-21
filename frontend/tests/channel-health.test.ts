import { describe, expect, it } from 'vitest';
import { getChannelHealth } from '@/lib/utils/formatters';
import { todayInTimeZone } from '@/lib/utils/dates';
import { ChannelConnectionStatus } from '@/types';

const base = { channel: 'ACME', available: true, status: ChannelConnectionStatus.CONNECTED };

describe('getChannelHealth: green only with evidence of a successful sync', () => {
  it('connected with a recorded sync and no error is the only green state', () => {
    expect(getChannelHealth({ ...base, lastSyncAt: '2026-10-19T08:00:00Z' })).toMatchObject({ state: 'ok', tone: 'green' });
  });

  it('connected but never synchronised is amber, not green', () => {
    expect(getChannelHealth(base)).toMatchObject({ state: 'never-synced', tone: 'amber' });
  });

  it('a standing error wins over an old successful sync', () => {
    expect(getChannelHealth({ ...base, lastSyncAt: '2026-10-19T08:00:00Z', lastError: 'HTTP 500' })).toMatchObject({ state: 'error', tone: 'red' });
  });

  it('error and expired connections are never green', () => {
    expect(getChannelHealth({ ...base, status: ChannelConnectionStatus.ERROR, lastSyncAt: '2026-10-19T08:00:00Z' }).tone).toBe('red');
    expect(getChannelHealth({ ...base, status: ChannelConnectionStatus.EXPIRED }).state).toBe('expired');
  });

  it('a channel without an adapter reports that partner access is needed, whatever its stored status', () => {
    expect(getChannelHealth({ ...base, available: false, lastSyncAt: '2026-10-19T08:00:00Z' })).toMatchObject({ state: 'unavailable', label: 'Partner access needed' });
  });

  it('connecting and disconnected are neutral', () => {
    expect(getChannelHealth({ ...base, status: ChannelConnectionStatus.CONNECTING }).state).toBe('connecting');
    expect(getChannelHealth({ ...base, status: ChannelConnectionStatus.DISCONNECTED }).state).toBe('disconnected');
  });

  it('built-in channels are labelled built in, never "synced"', () => {
    const direct = getChannelHealth({ channel: 'DIRECT', internal: true, status: ChannelConnectionStatus.CONNECTED });
    const tirvona = getChannelHealth({ channel: 'TIRVONA', internal: true, status: ChannelConnectionStatus.CONNECTED });
    expect(direct).toMatchObject({ state: 'internal', label: 'Built in' });
    expect(tirvona.label).toBe('Built in (marketplace)');
    expect(direct.tone).not.toBe('green');
  });
});

describe('todayInTimeZone', () => {
  it('uses the property calendar day, not the browser or UTC day', () => {
    const instant = new Date('2026-10-18T21:00:00Z'); // 02:30 on the 19th in Kolkata, still the 18th in UTC and New York
    expect(todayInTimeZone('Asia/Kolkata', instant)).toBe('2026-10-19');
    expect(todayInTimeZone('UTC', instant)).toBe('2026-10-18');
    expect(todayInTimeZone('America/New_York', instant)).toBe('2026-10-18');
    expect(todayInTimeZone('Not/AZone', instant)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
