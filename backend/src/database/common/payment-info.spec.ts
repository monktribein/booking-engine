import { NO_PAYMENT_INFO, hasProviderPaymentFields, initialChannelPaymentStatus, normalizePaymentInfo } from './payment-info';

const NOW = new Date('2027-01-01T00:00:00Z');

describe('normalizePaymentInfo: absence is information', () => {
  it('nothing in, nothing out (never paid, never collected)', () => {
    expect(normalizePaymentInfo(undefined)).toEqual(NO_PAYMENT_INFO);
    expect(normalizePaymentInfo(null)).toEqual(NO_PAYMENT_INFO);
    expect(normalizePaymentInfo({})).toEqual(NO_PAYMENT_INFO);
    expect(initialChannelPaymentStatus(normalizePaymentInfo({}))).toBe('UNKNOWN');
  });

  it('a collection claim needs a source; without one it is dropped', () => {
    expect(normalizePaymentInfo({ collectedBy: 'CHANNEL' })).toEqual(NO_PAYMENT_INFO);
    expect(normalizePaymentInfo({ collectedBy: 'CHANNEL', collectionSource: 'MAGIC' as never })).toEqual(NO_PAYMENT_INFO);
    const ok = normalizePaymentInfo({ collectedBy: 'CHANNEL', collectionSource: 'OPERATOR_CONFIG' }, NOW);
    expect(ok).toMatchObject({ collectionModel: 'CHANNEL', collectionSource: 'OPERATOR_CONFIG', paymentInfoUpdatedAt: null });
    expect(initialChannelPaymentStatus(ok)).toBe('CHANNEL_COLLECTED');
    expect(initialChannelPaymentStatus(normalizePaymentInfo({ collectedBy: 'PROPERTY', collectionSource: 'PROVIDER' }))).toBe('UNPAID');
  });

  it('provider fields are kept verbatim, with a normalised reading only when given', () => {
    const c = normalizePaymentInfo({ providerStatusRaw: '  captured  ', payoutStatusRaw: 'queued', commissionAmount: 100, netAmount: 900, payoutDate: new Date('2027-02-01T00:00:00Z') }, NOW);
    expect(c).toMatchObject({ providerPaymentStatusRaw: 'captured', providerPaymentStatus: null, payoutStatusRaw: 'queued', payoutStatus: null, commissionAmount: 100, netAmount: 900, paymentInfoUpdatedAt: NOW });
    expect(hasProviderPaymentFields(c)).toBe(true);
    expect(c.collectionModel).toBeNull(); // provider fields alone never imply who collects
  });

  it('drops values that are outside the lists, negative, fractional, unsafe or unparseable', () => {
    const c = normalizePaymentInfo({ providerStatus: 'SETTLED' as never, payoutStatus: 'SENT' as never, commissionAmount: -1, netAmount: 1.5, payoutDate: new Date('x'), providerStatusRaw: '   ' });
    expect(c).toEqual(NO_PAYMENT_INFO);
    expect(normalizePaymentInfo({ commissionAmount: Number.MAX_SAFE_INTEGER + 10 })).toEqual(NO_PAYMENT_INFO);
  });

  it('bounds the raw words', () => {
    expect(normalizePaymentInfo({ providerStatusRaw: 'x'.repeat(500) }).providerPaymentStatusRaw).toHaveLength(200);
  });

  it('zero is a valid reported amount (a zero commission is information)', () => {
    expect(normalizePaymentInfo({ commissionAmount: 0 }, NOW)).toMatchObject({ commissionAmount: 0, paymentInfoUpdatedAt: NOW });
  });
});
