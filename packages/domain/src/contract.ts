/**
 * Vertragssumme (DESIGN.md §4.4, rule 12): Hauptauftrag + beauftragte Nachträge. Partially
 * accepted change orders count with the net amount of their accepted positions only. Offered and
 * draft change orders are shown separately and never count as contract.
 */
export const CHANGE_ORDER_STATUSES = [
  'draft',
  'offered',
  'accepted',
  'partially_accepted',
  'rejected',
] as const
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number]

export interface ChangeOrderAmount {
  status: ChangeOrderStatus
  /** Net total of the change order (all positions). */
  netCents: bigint
  /** Net of the positions the client accepted (only relevant when partially accepted). */
  acceptedNetCents: bigint
}

export interface ContractTotals {
  /** Hauptauftrag (Auftragsbestätigung), net; 0 without contract. */
  contractNetCents: bigint
  /** Beauftragte Nachträge (accepted, partially accepted with their accepted part). */
  acceptedNetCents: bigint
  /** Angebotene, noch nicht entschiedene Nachträge. */
  offeredNetCents: bigint
  /** Nachträge im Entwurf. */
  draftNetCents: bigint
  /** Abgelehnte Nachträge and the rejected part of partially accepted ones. */
  rejectedNetCents: bigint
  /** Vertragssumme = Hauptauftrag + beauftragte Nachträge. */
  totalNetCents: bigint
  /** Vertragssumme if all offered change orders were accepted. */
  potentialNetCents: bigint
}

/** Counted part of a change order for the Vertragssumme. */
export function acceptedPart(order: ChangeOrderAmount): bigint {
  if (order.status === 'accepted') return order.netCents
  if (order.status === 'partially_accepted') return order.acceptedNetCents
  return 0n
}

export function contractTotals(
  contractNetCents: bigint | null,
  changeOrders: readonly ChangeOrderAmount[],
): ContractTotals {
  const totals = {
    contractNetCents: contractNetCents ?? 0n,
    acceptedNetCents: 0n,
    offeredNetCents: 0n,
    draftNetCents: 0n,
    rejectedNetCents: 0n,
  }
  for (const order of changeOrders) {
    switch (order.status) {
      case 'accepted':
      case 'partially_accepted': {
        const accepted = acceptedPart(order)
        totals.acceptedNetCents += accepted
        totals.rejectedNetCents += order.netCents - accepted
        break
      }
      case 'offered':
        totals.offeredNetCents += order.netCents
        break
      case 'draft':
        totals.draftNetCents += order.netCents
        break
      case 'rejected':
        totals.rejectedNetCents += order.netCents
        break
    }
  }
  const totalNetCents = totals.contractNetCents + totals.acceptedNetCents
  return { ...totals, totalNetCents, potentialNetCents: totalNetCents + totals.offeredNetCents }
}
