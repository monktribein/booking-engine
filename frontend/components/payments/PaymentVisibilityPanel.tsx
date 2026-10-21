import React from 'react';
import { Reservation } from '@/types';
import { describePayment, toneClass, type Line } from '@/lib/utils/payment-visibility';
import { formatCurrency } from '@/lib/utils/currency';

function Row({ term, line }: { term: string; line: Line }) {
  const unavailable = line.label === 'Unavailable';
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-x-3 py-1.5 text-xs">
      <dt className="text-slate-500">{term}</dt>
      <dd>
        <span className={`font-semibold ${toneClass(line.tone)}`} data-unavailable={unavailable ? 'true' : undefined}>
          {line.label}
        </span>
        <span className="block text-[11px] text-slate-500 dark:text-slate-400">{line.detail}</span>
      </dd>
    </div>
  );
}

/**
 * Read-only payment and payout visibility for one reservation. Channel bookings show only what the channel reported or an operator
 * declared, each with its source; anything else reads "Unavailable". Nothing here moves money.
 */
export function PaymentVisibilityPanel({ reservation }: { reservation: Reservation }) {
  const v = describePayment(reservation);
  return (
    <section aria-label="Payment visibility" className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
      <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">{v.isChannel ? 'Channel payment (read-only)' : 'Payment'}</h3>
      <dl className="divide-y divide-slate-100 dark:divide-slate-800">
        <Row term={v.isChannel ? 'Collection' : 'Guest payment'} line={v.summary} />
        {v.isChannel && <Row term="Channel says" line={v.providerStatus} />}
        {v.isChannel && <Row term="Payout" line={v.payout} />}
        {v.isChannel && <Row term="Commission" line={v.commission} />}
        {v.isChannel && <Row term="Net amount" line={v.net} />}
        <Row term="Refund" line={v.refund} />
        <div className="grid grid-cols-[8.5rem_1fr] gap-x-3 py-1.5 text-xs">
          <dt className="text-slate-500">Balance due</dt>
          <dd className="font-semibold text-slate-800 dark:text-slate-200">
            {v.balanceDue.known ? formatCurrency(v.balanceDue.amount, reservation.currency) : <span data-unavailable="true" className="text-slate-600 dark:text-slate-400">Unavailable</span>}
            {!v.balanceDue.known && <span className="block text-[11px] font-normal text-slate-500">It is not known whether the guest still owes the property anything</span>}
          </dd>
        </div>
      </dl>
    </section>
  );
}
