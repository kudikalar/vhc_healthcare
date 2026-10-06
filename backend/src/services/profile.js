import { db, nextSeq } from '../db.js';
import { now, today } from '../clock.js';
import { ageOn, isValidDate } from '../utils/dates.js';
import { maskEmail, maskMobile } from './security.js';

export const TERMS_VERSION = '2026-10';
export const PRIVACY_VERSION = '2026-10';

export const STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

export const displayName = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ');
export const newCustomerId = () => `CUS-${String(nextSeq('customer')).padStart(6, '0')}`;

/** Fields an application submission needs from the policyholder's profile. */
export function profileChecklist(u) {
  const a = u.profile?.address || {};
  const dob = u.profile?.dob;
  const adult = isValidDate(dob) && dob < today() && ageOn(dob, today()) >= 18;
  return [
    { key: 'legalName', label: 'Legal full name', ok: !!u.legalName?.trim(), required: true },
    { key: 'dob', label: 'Date of birth', ok: isValidDate(dob) && dob < today(), required: true },
    { key: 'adult', label: 'Policyholder is at least 18', ok: adult, required: true },
    { key: 'address', label: 'Address (line 1, city, state, postal code)', ok: !!(a.line1 && a.city && a.state && /^\d{6}$/.test(a.postalCode || '')), required: true },
    { key: 'email', label: 'Email verified', ok: !!u.emailVerified, required: true },
    { key: 'mobile', label: 'Mobile verified (needed for payouts)', ok: !!u.mobileVerified, required: false },
  ];
}

export function profileProblems(u) {
  const list = profileChecklist(u).filter((c) => c.required && !c.ok);
  return list.map((c) => (c.key === 'adult' ? 'Policyholder must be at least 18.' : `Complete your profile: ${c.label.toLowerCase()}`));
}

export function publicUser(u, { masked = false } = {}) {
  return {
    id: u.id, customerId: u.customerId || null, role: u.role, status: u.status, active: u.active,
    firstName: u.firstName, lastName: u.lastName, name: u.name, legalName: u.legalName || '',
    email: masked ? maskEmail(u.email) : u.email, emailVerified: !!u.emailVerified,
    mobile: masked ? maskMobile(u.mobile) : u.mobile || '', mobileVerified: !!u.mobileVerified,
    pendingEmail: masked ? undefined : u.pendingEmail || null, pendingMobile: masked ? undefined : u.pendingMobile || null,
    profile: { dob: u.profile?.dob || '', gender: u.profile?.gender || '', address: { country: 'India', ...(u.profile?.address || {}) } },
    communicationPreference: u.communicationPreference || 'email', marketingOptIn: !!u.marketingOptIn,
    profileVersion: u.profileVersion || 1, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null,
    checklist: u.role === 'customer' ? profileChecklist(u) : undefined,
  };
}

/** Saves a versioned snapshot of the profile before a change. */
export function snapshotProfile(u, actor, section) {
  u.profileHistory ||= [];
  u.profileHistory.push({
    version: u.profileVersion || 1, at: now().toISOString(), by: actor?.name, section,
    data: { legalName: u.legalName, profile: structuredClone(u.profile || {}), communicationPreference: u.communicationPreference, marketingOptIn: u.marketingOptIn },
  });
  u.profileVersion = (u.profileVersion || 1) + 1;
  db.touch(u);
}
