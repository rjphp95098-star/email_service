import { PrismaService } from "src/prisma/prisma.service";

// Atomically increments a settings.value counter via INSERT ... ON DUPLICATE
// KEY UPDATE. A separate findUnique-then-upsert read-modify-write loses
// updates when two app instances (or two overlapping runs) read the same
// starting value before either writes back - this collapses it into one
// statement MySQL serializes at the row level, safe under concurrent callers.
export async function incrementSettingCounter(
  prisma: PrismaService,
  key: string,
  amount: number,
): Promise<void> {
  if (amount <= 0) {
    return;
  }

  await prisma.$executeRaw`
    INSERT INTO settings (\`key\`, value, created_at, updated_at)
    VALUES (${key}, ${String(amount)}, NOW(), NOW())
    ON DUPLICATE KEY UPDATE value = CAST(value AS SIGNED) + ${amount}, updated_at = NOW()
  `;
}
