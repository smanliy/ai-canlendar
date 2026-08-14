const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');

dotenv.config({ path: './.env' });

const prisma = new PrismaClient();
const userId = process.argv[2];
const timezone = process.argv[3] || 'Asia/Shanghai';

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date(value))
    .replace(/\//g, '-');
}

async function main() {
  if (!userId) {
    throw new Error('Usage: node scripts/print-events.js <userId> [timezone]');
  }

  const events = await prisma.calendarEvent.findMany({
    where: {
      userId,
      deletedAt: null,
    },
    orderBy: {
      startTime: 'asc',
    },
    select: {
      id: true,
      title: true,
      startTime: true,
      endTime: true,
      category: true,
      priority: true,
      status: true,
      source: true,
    },
  });

  console.log(`USER ${userId}`);
  console.log(`TIMEZONE ${timezone}`);
  console.log(`COUNT ${events.length}`);
  console.log('FORMAT YYYY-MM-DD HH:mm - YYYY-MM-DD HH:mm | title | category/priority | status | source | id');
  console.log('-'.repeat(150));

  for (const event of events) {
    console.log(
      [
        `${formatDate(event.startTime)} - ${formatDate(event.endTime)}`,
        event.title,
        `${event.category}/${event.priority}`,
        event.status,
        event.source,
        event.id,
      ].join(' | '),
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
