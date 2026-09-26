import { randomBytes } from "crypto";

function generateRandomPart(length = 8): string {
  return randomBytes(length)
    .toString("hex")
    .substring(0, length)
    .toUpperCase();
}

export const generateSenderGuid = () =>
  `Sndr_${generateRandomPart()}`;

export const generateTemplateGuid = () =>
  `Tpl_${generateRandomPart()}`;

export const generateWebhookGuid = () =>
  `WhEvt_${generateRandomPart()}`;