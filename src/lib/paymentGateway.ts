import { env } from '../config/env';
import * as monnify from './monnify';
import * as paystack from './paystack';

export type {
  InitTransactionInput,
  InitTransactionResult,
  MonnifyBank as GatewayBank,
  MonnifyTxnStatus as GatewayTxnStatus,
  MonnifyCardDetails as GatewayCardDetails,
  ChargeCardInput,
  ChargeCardResult,
  DisbursementInput,
  DisbursementResult,
} from './monnify';

/**
 * Single switch point for which payment processor is live. Both
 * implementations (src/lib/monnify.ts, src/lib/paystack.ts) are complete and
 * kept working — flipping PAYMENT_GATEWAY is the only change needed to move
 * between them; nothing downstream imports a concrete provider directly.
 */
const active = env.PAYMENT_GATEWAY === 'monnify' ? monnify : paystack;

/** Human-readable label for the active gateway — used on transaction/method fields. */
export const GATEWAY_LABEL = env.PAYMENT_GATEWAY === 'monnify' ? 'Monnify' : 'Paystack';

export const initTransaction = active.initTransaction;
export const verifyAccountName = active.verifyAccountName;
export const getBanks = active.getBanks;
export const getTransactionStatus = active.getTransactionStatus;
export const getCardDetails = active.getCardDetails;
export const chargeCardToken = active.chargeCardToken;
export const initiateDisbursement = active.initiateDisbursement;
export const getDisbursementStatus = active.getDisbursementStatus;

/** Whether payout disbursement is configured for whichever gateway is active. */
export function isDisbursementConfigured(): boolean {
  return env.PAYMENT_GATEWAY === 'monnify' ? !!env.MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT : !!env.PAYSTACK_SECRET_KEY;
}
