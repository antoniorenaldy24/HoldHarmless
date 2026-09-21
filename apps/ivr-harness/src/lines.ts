/**
 * Every line the harness can speak — §10.2, §10.5.
 *
 * All speech is pre-rendered by scripts/render-assets.ts; nothing here is
 * synthesized at runtime. `speakAs` takes a LineId, never text (§12.10), so a
 * runtime TTS call cannot be introduced by accident: text that is not in this
 * table has no audio.
 *
 * Every value that sounds like data is synthetic (INV-12): the plan, the
 * personas, the authorization and reference numbers.
 *
 * Spelled alphanumerics use "X, as in X-ray" with commas, as a representative
 * reads them. ADR-020 records that commas between bare digits caused a grouping
 * error on Day 0 ("three, three, nine" heard as "331", "9"); that is a property
 * of the rig worth keeping visible, not smoothing away, so these lines keep the
 * representative's rhythm rather than a recognizer-friendly one.
 */

export type Role = 'ivr' | 'rep1' | 'rep2';

/**
 * Voice per role. §6.6 and §10.5 require a distinct voice for the IVR, the
 * first representative and the second — party detection is calibrated on the
 * difference. The second representative differs from the first in accent AND
 * gender, so the two are not near neighbours.
 *
 * Rate: -15%, chosen by ear on Day 0 (Andrew at -15% and -20% compared; -15%
 * kept). The IVR is slightly faster, as recorded menus are.
 */
export const ROLE_VOICES: Readonly<Record<Role, { voice: string; rate: string }>> = {
  ivr: { voice: 'en-US-AriaNeural', rate: '-10%' },
  rep1: { voice: 'en-US-AndrewNeural', rate: '-15%' },
  rep2: { voice: 'en-GB-SoniaNeural', rate: '-15%' },
};

type LineSpec = { role: Role; text: string; purpose: string };

export const LINES = {
  // --- IVR: a three-level menu, verbose (the option is named before its digit) ---
  ivr_main_menu: {
    role: 'ivr',
    purpose: 'menu level 1',
    text:
      'Thank you for calling Synthetic Health Plan provider services. ' +
      'For eligibility and benefits, press or say one. ' +
      'For claims, press or say two. ' +
      'For prior authorization, press or say three.',
  },
  ivr_priorauth_menu: {
    role: 'ivr',
    purpose: 'menu level 2',
    text:
      'Prior authorization. ' +
      'To submit a new prior authorization request, press or say one. ' +
      'To check the status of an existing request, press or say two.',
  },
  ivr_service_menu: {
    role: 'ivr',
    purpose: 'menu level 3',
    text:
      'For an outpatient procedure or imaging, press or say one. ' +
      'For an inpatient admission, press or say two. ' +
      'For pharmacy, press or say three.',
  },
  ivr_invalid: { role: 'ivr', purpose: 'invalid choice', text: 'Sorry, that option is not available.' },
  ivr_no_input: { role: 'ivr', purpose: 'timeout before repeat (6 s)', text: "Sorry, I didn't get a response." },
  ivr_goodbye_no_input: { role: 'ivr', purpose: 'repeat limit reached', text: 'We did not receive a response. Goodbye.' },
  ivr_connecting: { role: 'ivr', purpose: 'into the representative queue', text: 'Please hold while we connect you to the next available representative.' },
  ivr_hold_announcement: { role: 'ivr', purpose: 'mid-hold announcement (A-7)', text: 'Your call is important to us. Please stay on the line, and a representative will be with you shortly.' },

  // --- First representative ---
  rep1_greeting: { role: 'rep1', purpose: 'first human turn', text: 'Thank you for holding, provider services, this is Jordan. How can I help you today?' },
  rep1_ask_npi: { role: 'rep1', purpose: 'field request', text: "Okay. Can I get the provider's NPI, please?" },
  rep1_ask_member_id: { role: 'rep1', purpose: 'field request', text: "And the member's ID number?" },
  rep1_ask_dob: { role: 'rep1', purpose: 'field request', text: "What is the member's date of birth?" },
  rep1_ask_cpt: { role: 'rep1', purpose: 'field request', text: 'Which procedure code are you requesting?' },
  rep1_ask_icd: { role: 'rep1', purpose: 'field request', text: 'And the diagnosis code?' },
  rep1_ask_service_date: { role: 'rep1', purpose: 'field request', text: 'What is the date of service?' },
  rep1_ask_clinical: { role: 'rep1', purpose: 'field request', text: 'Can you give me the clinical reason for the request?' },
  rep1_repeat_member_id: { role: 'rep1', purpose: 'repeat request', text: 'Sorry, can you repeat the member ID?' },
  rep1_backchannel: { role: 'rep1', purpose: 'backchannel while digits are read', text: 'Mm-hmm.' },
  rep1_hold_cue: { role: 'rep1', purpose: 'hold announcement phrase (A-11)', text: 'One moment please, let me look that up.' },
  rep1_cue_no_hold: { role: 'rep1', purpose: 'cue phrase without a hold (A-27)', text: 'Let me check that for you. Okay, I see it right here.' },
  rep1_clinical_question: { role: 'rep1', purpose: 'clinical question -> escalation', text: 'Was conservative therapy tried for at least six weeks before this request?' },
  rep1_approved: {
    role: 'rep1',
    purpose: 'approval with a spelled authorization number (A-13, A-24)',
    text: "Okay, that's approved. Your authorization number is P, as in Papa, A, as in alpha, seven, seven, eight, one, Q, as in Quebec, X, as in X-ray.",
  },
  rep1_readback_correct: { role: 'rep1', purpose: 'read-back confirmed', text: "Yes, that's correct." },
  rep1_readback_wrong: { role: 'rep1', purpose: 'read-back corrected', text: "No, the last letter is X, as in X-ray, not S." },
  rep1_reference: { role: 'rep1', purpose: 'call reference', text: 'Your call reference number is R, as in Romeo, one, four, two, zero, nine.' },
  rep1_denied_boilerplate: { role: 'rep1', purpose: 'boilerplate denial (§8.5.1)', text: "That request is denied. It's not medically necessary." },
  rep1_pending_info: { role: 'rep1', purpose: 'document request -> pending_info', text: "We'll need the clinical notes faxed over before we can make a determination." },
  rep1_transfer: { role: 'rep1', purpose: 'department transfer (A-12)', text: "I'm going to transfer you to utilization management. Please hold." },
  rep1_hold_during_closing: { role: 'rep1', purpose: 'hold during closing (A-21)', text: 'Oh, hold on, let me get that for you.' },
  rep1_one_more_thing: { role: 'rep1', purpose: 'late addition during closing', text: 'Oh wait, one more thing before you go.' },
  rep1_goodbye: { role: 'rep1', purpose: 'closing', text: "You're welcome. Have a good day." },

  // --- Second representative: after a transfer, or a silent party swap ---
  rep2_greeting_um: { role: 'rep2', purpose: 'after transfer: new party (A-12)', text: 'Utilization management, this is Priya speaking. Who am I speaking with?' },
  rep2_greeting_swap: { role: 'rep2', purpose: 'short-hold party swap, no transfer phrase (A-20)', text: "Hi, thanks for waiting. I'm picking this one up. What can I do for you?" },
  rep2_ask_member_id: { role: 'rep2', purpose: 'field request', text: 'Can I get the member ID to pull up the case?' },
  rep2_approved: {
    role: 'rep2',
    purpose: 'approval from the second party',
    text: 'Alright, I can approve that. The authorization number is K, as in kilo, nine, three, zero, two, M, as in Mike.',
  },
  rep2_goodbye: { role: 'rep2', purpose: 'closing', text: 'Thanks, take care.' },
} as const satisfies Record<string, LineSpec>;

export type LineId = keyof typeof LINES;

export const LINE_IDS = Object.keys(LINES) as LineId[];

export function lineSpec(id: LineId): LineSpec {
  return LINES[id];
}
