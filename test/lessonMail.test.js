import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { lessonCancellation } from "../lib/ics.js";
import { sendLessonCancelledEmail, sendLessonMovedEmail } from "../lib/lessonMail.js";

const originalFetch = global.fetch;
const originalKey = process.env.RESEND_API_KEY;
const requests = [];

const oldLesson = {
  id: "lesson_123",
  type: "membership",
  player: "Cashin",
  date: "2026-10-05",
  time: "5:00 PM",
  focus: "Hitting",
};

before(() => {
  process.env.RESEND_API_KEY = "re_test";
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true };
  };
});

after(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalKey;
});

function decode(attachment) {
  return Buffer.from(attachment.content, "base64").toString("utf8");
}

test("a cancellation attachment removes the matching calendar event", () => {
  const attachment = lessonCancellation(oldLesson);
  const calendar = decode(attachment);

  assert.equal(attachment.content_type, "text/calendar; charset=utf-8; method=CANCEL");
  assert.match(calendar, /METHOD:CANCEL/);
  assert.match(calendar, /UID:lesson_123@apacademybsb\.com/);
  assert.match(calendar, /SEQUENCE:1/);
  assert.match(calendar, /STATUS:CANCELLED/);
  assert.doesNotMatch(calendar, /BEGIN:VALARM/);
});

test("cancel email includes the original calendar cancellation", async () => {
  requests.length = 0;
  assert.equal(
    await sendLessonCancelledEmail({
      to: "parent@example.com",
      lesson: oldLesson,
      cancelledBy: "parent",
    }),
    true
  );

  assert.match(requests[0].subject, /Lesson cancelled/);
  assert.equal(requests[0].attachments.length, 1);
  assert.match(decode(requests[0].attachments[0]), /STATUS:CANCELLED/);
});

test("move email cancels the old event and adds the new event", async () => {
  requests.length = 0;
  const newLesson = {
    ...oldLesson,
    id: "lesson_456",
    date: "2026-10-06",
    time: "6:00 PM",
  };

  assert.equal(
    await sendLessonMovedEmail({
      to: "parent@example.com",
      oldLesson,
      newLesson,
      movedBy: "coach",
    }),
    true
  );

  const [cancelled, updated] = requests[0].attachments;
  assert.equal(requests[0].attachments.length, 2);
  assert.match(decode(cancelled), /UID:lesson_123@apacademybsb\.com/);
  assert.match(decode(cancelled), /METHOD:CANCEL/);
  assert.match(decode(updated), /UID:lesson_456@apacademybsb\.com/);
  assert.match(decode(updated), /STATUS:CONFIRMED/);
});
