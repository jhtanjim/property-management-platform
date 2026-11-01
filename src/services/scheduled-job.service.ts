import { query } from '../config/database';
import { SUBSCRIPTION_REMINDER_TABLE_NAME } from '../models/building-record.model';
import {
  markLeasedUnitsOccupied,
  releaseUnitsWithExpiredLeases,
} from '../repositories/lease.repository';
import { sendSubscriptionReminderEmail } from '../utils/mailer';
import { sendSms } from '../utils/sms';

import { generateInvoicesForAllLeases } from './invoice.service';

const REMINDER_DAYS = [1, 3, 7];

// Emails and texts each owner 7, 3 and 1 days before a subscription ends, once per subscription period.
const sendSubscriptionReminders = async (): Promise<number> => {
  const due = await query<{
    id: string;
    title: string;
    email: string;
    phoneNumber: string | null;
    endsAt: Date;
    daysLeft: number;
  }>(
    `SELECT p.id, p.title, a.email, a."phoneNumber", p."subscriptionEndsAt" AS "endsAt",
            CEIL(EXTRACT(EPOCH FROM (p."subscriptionEndsAt" - NOW())) / 86400)::int AS "daysLeft"
       FROM properties p
       JOIN admins a ON a.id = p."ownerId"
      WHERE p."deletedAt" IS NULL
        AND p."subscriptionEndsAt" > NOW()
        AND p."subscriptionEndsAt" <= NOW() + INTERVAL '7 days';`,
  );
  let sent = 0;
  for (const row of due.rows) {
    const days = REMINDER_DAYS.find((d) => row.daysLeft <= d);
    if (days === undefined) {
      continue;
    }
    const claimed = await query(
      `INSERT INTO ${SUBSCRIPTION_REMINDER_TABLE_NAME} ("propertyId","endsAt",days)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING days;`,
      [row.id, row.endsAt, days],
    );
    if (claimed.rows.length === 0) {
      continue;
    }
    try {
      await sendSubscriptionReminderEmail(row.email, {
        propertyTitle: row.title,
        daysLeft: row.daysLeft,
        endsOn: row.endsAt.toISOString().slice(0, 10),
      });
      sent += 1;
    } catch (error) {
      console.warn('[jobs] could not send a subscription reminder:', error);
      // Release the claim so the next run tries again.
      await query(
        `DELETE FROM ${SUBSCRIPTION_REMINDER_TABLE_NAME}
          WHERE "propertyId" = $1 AND "endsAt" = $2 AND days = $3;`,
        [row.id, row.endsAt, days],
      );
      continue;
    }
    // Only after the email, and a failed text does not repeat the email on the next run.
    if (row.phoneNumber) {
      const dayWord = row.daysLeft === 1 ? 'day' : 'days';
      await sendSms(
        row.phoneNumber,
        `EstateOps: the subscription for ${row.title} ends in ${row.daysLeft} ${dayWord}. Please renew it.`,
      ).catch((error: unknown) => {
        console.warn('[jobs] could not send a subscription reminder SMS:', error);
      });
    }
  }
  return sent;
};

// Safe to run any number of times: each lease gets one invoice a month, each reminder goes once.
const runDailyJobs = async (): Promise<{
  invoicesCreated: number;
  invoicesSkipped: number;
  remindersSent: number;
  unitsOccupied: number;
  unitsReleased: number;
}> => {
  const month = `${new Date().toISOString().slice(0, 7)}-01`;
  const { created, skipped } = await generateInvoicesForAllLeases(month);
  const remindersSent = await sendSubscriptionReminders();
  const unitsOccupied = await markLeasedUnitsOccupied();
  const unitsReleased = await releaseUnitsWithExpiredLeases();
  return {
    invoicesCreated: created,
    invoicesSkipped: skipped,
    remindersSent,
    unitsOccupied,
    unitsReleased,
  };
};

export { runDailyJobs };
