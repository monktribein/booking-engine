'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { providersApi, type CsvColumns, type CsvImportResult } from '@/lib/api/providers';
import { roomTypesApi } from '@/lib/api/room-types';
import { errorMessage } from '@/lib/utils/errors';
import { formatCurrency } from '@/lib/utils/currency';

const MAX_BYTES = 1024 * 1024;
const FIELDS: { key: keyof CsvColumns; label: string; required: boolean; hints: RegExp }[] = [
  { key: 'reference', label: 'Your booking reference', required: true, hints: /ref|id|booking|conf/i },
  { key: 'checkIn', label: 'Check-in date', required: true, hints: /arriv|check.?in|from|start/i },
  { key: 'checkOut', label: 'Check-out date', required: true, hints: /depart|check.?out|to|end/i },
  { key: 'adults', label: 'Adults', required: true, hints: /adult|guests|pax/i },
  { key: 'guestFirstName', label: 'Guest first name', required: true, hints: /first|name/i },
  { key: 'total', label: 'Total price of the stay', required: true, hints: /total|price|amount/i },
  { key: 'guestLastName', label: 'Guest last name', required: false, hints: /last|surname|family/i },
  { key: 'email', label: 'E-mail', required: false, hints: /mail/i },
  { key: 'phone', label: 'Phone', required: false, hints: /phone|mobile|tel/i },
  { key: 'notes', label: 'Notes', required: false, hints: /note|remark|request/i },
];
const DATE_FORMATS = [
  { value: 'YYYY-MM-DD', label: '2027-03-10 (year-month-day)' },
  { value: 'DD/MM/YYYY', label: '10/03/2027 (day/month/year)' },
  { value: 'MM/DD/YYYY', label: '03/10/2027 (month/day/year)' },
];

/** Reads a file as text (File.text where it exists, FileReader otherwise). */
function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error ?? new Error('The file could not be read'));
    r.readAsText(file);
  });
}

/** First line of the file, split the way the server will (delimiter chosen by count). */
function readHeader(text: string): string[] {
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].map((d) => ({ d, n: first.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  return first.split(delimiter).map((h) => h.trim().replace(/^"|"$/g, '')).filter(Boolean);
}
function guess(header: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of FIELDS) {
    const hit = header.find((h) => !used.has(h) && f.hints.test(h));
    if (hit) {
      out[f.key] = hit;
      used.add(hit);
    }
  }
  return out;
}

export function CsvImportDialog({ propertyId, currency, isOpen, onClose }: { propertyId: string; currency: string; isOpen: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [header, setHeader] = useState<string[]>([]);
  const [columns, setColumns] = useState<Record<string, string>>({});
  const [roomTypeId, setRoomTypeId] = useState('');
  const [dateFormat, setDateFormat] = useState('YYYY-MM-DD');
  const [result, setResult] = useState<CsvImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const roomTypes = useQuery({ queryKey: ['room-types', propertyId], queryFn: () => roomTypesApi.list(propertyId), enabled: isOpen });

  const payload = (dryRun: boolean) => ({ csv, roomTypeId, columns: columns as unknown as CsvColumns, dateFormat, dryRun });
  const check = useMutation({
    mutationFn: () => providersApi.importCsv(propertyId, payload(true)),
    onSuccess: (r) => { setResult(r); setError(null); },
    onError: (e) => { setResult(null); setError(errorMessage(e)); },
  });
  const run = useMutation({
    mutationFn: () => providersApi.importCsv(propertyId, payload(false)),
    onSuccess: async (r) => {
      setResult(r);
      setError(null);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['reservations'] }), queryClient.invalidateQueries({ queryKey: ['inventory'] })]);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const reset = () => {
    setCsv(''); setFileName(''); setHeader([]); setColumns({}); setResult(null); setError(null); check.reset(); run.reset();
  };
  const close = () => { reset(); onClose(); };
  const required = FIELDS.filter((f) => f.required).every((f) => columns[f.key]);
  const ready = !!csv && !!roomTypeId && required;
  const imported = result && !result.dryRun;

  return (
    <Dialog isOpen={isOpen} onClose={close} title="Import bookings from a spreadsheet" description="Check the file first: nothing is saved until you confirm. Every row is booked through the normal booking rules, so rooms cannot be oversold." maxWidth="2xl">
      <div className="space-y-4 text-xs">
        {error && <Alert variant="danger" message={error} onClose={() => setError(null)} />}

        <div>
          <label htmlFor="csv-file" className="mb-1 block font-semibold text-slate-700 dark:text-slate-300">CSV file (up to 1 MB, 1000 rows)</label>
          <input
            id="csv-file"
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > MAX_BYTES) {
                setError('The file is larger than 1 MB.');
                return;
              }
              let text: string;
              try {
                text = await readText(file);
              } catch (err) {
                setError(errorMessage(err));
                return;
              }
              const h = readHeader(text);
              setCsv(text); setFileName(file.name); setHeader(h); setColumns(guess(h)); setResult(null); setError(null);
            }}
          />
          {fileName && <p className="mt-1 text-slate-500">{fileName}: {header.length} columns found</p>}
        </div>

        {header.length > 0 && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Select label="Room type to book" value={roomTypeId} onChange={(e) => { setRoomTypeId(e.target.value); setResult(null); }} options={[{ value: '', label: 'Choose…' }, ...(roomTypes.data ?? []).map((r) => ({ value: r._id, label: r.name }))]} />
              <Select label="Date format in the file" value={dateFormat} onChange={(e) => { setDateFormat(e.target.value); setResult(null); }} options={DATE_FORMATS} />
              {FIELDS.map((f) => (
                <Select
                  key={f.key}
                  label={`${f.label}${f.required ? ' *' : ''}`}
                  value={columns[f.key] ?? ''}
                  onChange={(e) => { setColumns({ ...columns, [f.key]: e.target.value }); setResult(null); }}
                  options={[{ value: '', label: f.required ? 'Choose a column…' : 'Not in the file' }, ...header.map((h) => ({ value: h, label: h }))]}
                />
              ))}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={!ready} isLoading={check.isPending} onClick={() => check.mutate()}>Check the file</Button>
              {result?.dryRun && result.totals.ok > 0 && (
                <Button size="sm" isLoading={run.isPending} onClick={() => run.mutate()}>Import {result.totals.ok} booking{result.totals.ok === 1 ? '' : 's'}</Button>
              )}
            </div>
          </>
        )}

        {result && (
          <div className="space-y-2" data-testid="csv-result">
            <Alert
              variant={result.totals.errors ? 'warning' : 'success'}
              message={
                imported
                  ? `Imported ${result.totals.imported} booking${result.totals.imported === 1 ? '' : 's'}; ${result.totals.duplicates} already existed; ${result.totals.errors} could not be imported.`
                  : `${result.totals.ok} row${result.totals.ok === 1 ? '' : 's'} ready, ${result.totals.duplicates} already imported, ${result.totals.errors} with problems. Nothing has been saved yet.`
              }
            />
            <div className="max-h-72 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
              <table className="w-full">
                <thead className="bg-slate-50 dark:bg-slate-800/50 text-left text-[11px] uppercase text-slate-500">
                  <tr><th className="px-3 py-2">Line</th><th className="px-3 py-2">Reference</th><th className="px-3 py-2">Stay</th><th className="px-3 py-2">Result</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {result.rows.map((r) => (
                    <tr key={r.line}>
                      <td className="px-3 py-1.5">{r.line}</td>
                      <td className="px-3 py-1.5 font-mono">{r.reference ?? ''}</td>
                      <td className="px-3 py-1.5">{r.summary ? `${r.summary.checkIn} → ${r.summary.checkOut} • ${formatCurrency(r.summary.total, currency)}` : ''}</td>
                      <td className="px-3 py-1.5">
                        <Badge variant={r.status === 'ERROR' ? 'danger' : r.status === 'DUPLICATE' ? 'default' : 'success'}>{r.status === 'OK' ? 'ready' : r.status.toLowerCase()}</Badge>
                        {r.errors.length > 0 && <div className="mt-0.5 text-rose-600">{r.errors.join('; ')}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="flex justify-end"><Button variant="outline" size="sm" onClick={close}>{imported ? 'Done' : 'Close'}</Button></div>
      </div>
    </Dialog>
  );
}
