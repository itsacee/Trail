import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  issueMemberOtp,
  verifyMemberOtp,
  clearMemberOtpMemory,
  generateOtpCode,
} from "../lib/memberOtp.js";

beforeEach(() => {
  process.env.BLOB_MEMORY_STORE = "1";
  process.env.MEMBER_OTP_PEPPER = "test-pepper";
  clearMemberOtpMemory();
});

test("OTP codes are 6 digits", () => {
  for (let i = 0; i < 20; i++) {
    assert.match(generateOtpCode(), /^\d{6}$/);
  }
});

test("valid OTP verifies once then rejects reuse", async () => {
  const issued = await issueMemberOtp("parent@example.com");
  assert.equal(issued.ok, true);
  assert.match(issued.code, /^\d{6}$/);
  const ok = await verifyMemberOtp("parent@example.com", issued.code);
  assert.equal(ok.ok, true);
  const again = await verifyMemberOtp("parent@example.com", issued.code);
  assert.equal(again.ok, false);
});

test("wrong OTP increments toward lock", async () => {
  const issued = await issueMemberOtp("a@example.com");
  assert.equal(issued.ok, true);
  for (let i = 0; i < 4; i++) {
    const bad = await verifyMemberOtp("a@example.com", "000000");
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "invalid");
  }
  const locked = await verifyMemberOtp("a@example.com", "000000");
  assert.equal(locked.ok, false);
  assert.equal(locked.error, "locked");
});

test("resend cooldown blocks rapid reissue", async () => {
  const first = await issueMemberOtp("b@example.com");
  assert.equal(first.ok, true);
  const second = await issueMemberOtp("b@example.com");
  assert.equal(second.ok, false);
  assert.equal(second.error, "cooldown");
});

test("email enumeration-safe verify rejects unknown email without leaking", async () => {
  const res = await verifyMemberOtp("nobody@example.com", "123456");
  assert.equal(res.ok, false);
  assert.equal(res.error, "invalid");
});
