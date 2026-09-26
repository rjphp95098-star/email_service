const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const GUID = 'EmLst_9F644F47';
(async () => {
  let lastCount = 0;
  for (let i = 0; i < 400; i++) {
    const ev = await p.webhookEvent.findMany({ where: { emailGuid: GUID }, orderBy: { id: 'asc' } });
    const term = ev.find((e) => ['delivered', 'bounce', 'dropped', 'blocked'].includes(e.eventType));
    if (term) {
      console.log(`TERMINAL: ${term.eventType} | ${JSON.stringify(term.webhookPayload.response ?? term.webhookPayload.reason ?? '')}`);
      break;
    }
    const defs = ev.filter((e) => e.eventType === 'deferred');
    if (defs.length !== lastCount) {
      lastCount = defs.length;
      console.log(`still deferred, attempts=${defs.length - 1} (${new Date().toISOString()})`);
    }
    await new Promise((r) => setTimeout(r, 60000));
  }
  await p.$disconnect();
})().catch((e) => { console.error('watcher error:', e.message); process.exit(1); });
