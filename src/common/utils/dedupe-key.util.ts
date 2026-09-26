import { createHash } from 'crypto';

export function generateDedupeKey(payload: any): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        projectKey: payload.projectKey,
        templateKey: payload.templateKey,
        to: payload.to?.sort(),
        cc: payload.cc?.sort(),
        bcc: payload.bcc?.sort(),
        data: payload.data,
      }),
    )
    .digest('hex');
}