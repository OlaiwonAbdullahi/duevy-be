import { DiditClient } from './client';
import {
  type BvnResult,
  type CheckCodeResult,
  type IdentityVerifier,
  type SendCodeInput,
  type SendCodeOutcome,
  type ValidateBvnInput,
} from '../types';

/**
 * Didit standalone APIs:
 *  - POST /v3/phone/send/   then  POST /v3/phone/check/  (OTP, 5-minute code)
 *  - POST /v3/database-validation/  with issuing_state NGA and `bvn`
 * All three answer synchronously; no session or webhook is involved.
 */

interface SendResponse {
  status?: 'Success' | 'Retry' | 'Blocked';
  reason?: string | null;
}
interface CheckResponse {
  status?: 'Approved' | 'Failed' | 'Declined' | 'Expired or Not Found';
  message?: string;
  phone?: { full_number?: string } | null;
}
interface ValidationResponse {
  request_id?: string;
  database_validation?: {
    status?: string;
    match_type?: 'full_match' | 'partial_match' | 'no_match';
    validations?: { validation?: Record<string, string> }[] | Record<string, string>;
    errors?: { code?: string; retryable?: boolean }[];
  };
  validation_errors?: { code?: string; retryable?: boolean }[];
}

export interface DiditConfig {
  baseUrl: string;
  apiKey: string;
  phoneChannel: 'sms' | 'whatsapp' | 'telegram' | 'voice';
  /** Pin the BVN service; unset runs Didit's Nigeria default. */
  bvnServiceId?: string;
}

function fieldMatches(v: ValidationResponse['database_validation']): Record<string, string> {
  const validations = v?.validations;
  if (!validations) return {};
  if (!Array.isArray(validations)) return validations;
  return Object.assign({}, ...validations.map((x) => x.validation ?? {}));
}

export class DiditVerifier implements IdentityVerifier {
  readonly name = 'didit';
  private readonly client: DiditClient;

  constructor(private readonly config: DiditConfig) {
    this.client = new DiditClient(config.baseUrl, config.apiKey);
  }

  async sendPhoneCode(input: SendCodeInput): Promise<SendCodeOutcome> {
    const { status, body } = await this.client.post<SendResponse>(
      '/v3/phone/send/',
      {
        phone_number: input.phone,
        options: { code_size: 6, preferred_channel: this.config.phoneChannel },
        vendor_data: input.vendorData,
        signals: { ...(input.ip ? { ip: input.ip } : {}), ...(input.userAgent ? { user_agent: input.userAgent } : {}) },
      },
      'phone.send',
    );
    // 400: the number can't receive a code (unreachable, short code, bad format).
    if (status >= 400) return 'blocked';
    return body.status === 'Blocked' ? 'blocked' : 'sent';
  }

  async checkPhoneCode(phone: string, code: string): Promise<CheckCodeResult> {
    const { status, body } = await this.client.post<CheckResponse>(
      '/v3/phone/check/',
      { phone_number: phone, code, voip_number_action: 'DECLINE', disposable_number_action: 'DECLINE' },
      'phone.check',
    );
    if (status >= 400) return { outcome: 'wrong_code', phone: null, message: 'The code is not in the right format' };
    const message = body.message ?? null;
    switch (body.status) {
      case 'Approved':
        return { outcome: 'approved', phone: body.phone?.full_number ?? phone, message };
      case 'Failed':
        return { outcome: 'wrong_code', phone: null, message };
      case 'Declined':
        return { outcome: 'declined', phone: null, message };
      default:
        return { outcome: 'expired', phone: null, message };
    }
  }

  async validateBvn(input: ValidateBvnInput): Promise<BvnResult> {
    const { status, body } = await this.client.post<ValidationResponse>(
      '/v3/database-validation/',
      {
        issuing_state: 'NGA',
        bvn: input.bvn,
        first_name: input.firstName,
        last_name: input.lastName,
        date_of_birth: input.dob,
        consent: true,
        vendor_data: input.vendorData,
        ...(this.config.bvnServiceId ? { services: [this.config.bvnServiceId] } : {}),
      },
      'bvn.validate',
    );
    const requestId = body.request_id ?? null;
    if (status >= 400) {
      // Refused before or by the registry: the BVN itself was not accepted. Not billed.
      return { outcome: 'invalid', requestId, fieldMatches: {} };
    }
    const v = body.database_validation;
    const matches = fieldMatches(v);
    // Every selected service failed to answer: retry later, not the rep's fault.
    if (Object.keys(matches).length === 0 && (v?.errors?.length ?? 0) > 0) {
      return { outcome: 'unavailable', requestId, fieldMatches: {} };
    }
    const outcome =
      v?.match_type === 'full_match' && v.status === 'Approved'
        ? 'match'
        : v?.match_type === 'partial_match' || v?.match_type === 'full_match'
          ? 'partial'
          : 'no_match';
    return { outcome, requestId, fieldMatches: matches };
  }
}
