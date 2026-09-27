/**
 * Eval questions. `notes` tell the judge what a strong answer gets right; the
 * judge still checks every claim against the full dataset, not just these notes.
 */

import type { ChatTurn } from "../src/agent.ts";

export interface EvalCase {
  id: string;
  question: string;
  notes: string;
  /** Earlier turns in the same chat, for follow-up questions. */
  history?: ChatTurn[];
}

export const cases: EvalCase[] = [
  {
    id: "compare-acme-globex",
    question: "Compare Acme and Globex and tell me which one appears to be growing faster.",
    notes:
      '"Acme" is ambiguous: Acme Corp (FY2025 +5.5%) and Acme Robotics (+47%) are unrelated companies. ' +
      "The agent should ask which Acme is meant (naming both) rather than guess; a short clarifying question " +
      "is a full-marks response. Globex grew ~2.1% in FY2025 with only ~0.6% organic.",
  },
  {
    id: "umbrella-risks",
    question: "What are the biggest risks Umbrella Health flags in its filings?",
    notes:
      "Key risk is reliance on acquisitions (~6.5pp of 9.6% FY2025 growth; same-clinic growth 3.1%) " +
      "and integrating them. Integration costs and nursing wage inflation pressured operating margin.",
  },
  {
    id: "initech-subscription",
    question: "How is Initech's subscription transition going?",
    notes:
      "Subscription was 62% of revenue in FY2024 (sub +26%, perpetual -19%, NRR 112%), guided to ~68% for FY2025. " +
      "FY2025 is not filed: figures are preliminary and unaudited, which a strong answer makes clear.",
  },
  {
    id: "fastest-growing",
    question: "Which company in the universe is growing fastest?",
    notes:
      "Acme Robotics (+47% FY2025). Initech has no filed FY2025 (preliminary ~13-15%). " +
      "Umbrella's growth is largely acquired.",
  },
  {
    id: "tickers-glbx-itch",
    question: "Is GLBX a better business than ITCH?",
    notes:
      "Tickers must be resolved: GLBX = Globex Inc, ITCH = Initech. Initech has much higher gross and operating " +
      "margins and faster growth; Globex is larger but mature. 'Better' is a judgement call the answer should frame.",
  },
  {
    id: "out-of-coverage",
    question: "What was Hooli's revenue last year?",
    notes: "Hooli is not in the coverage universe. The answer must say so and must not invent figures.",
  },
  {
    id: "follow-up-pronoun",
    history: [
      {
        question: "How is Initech's subscription transition going?",
        answer:
          "Well so far. Subscription was 62% of FY2024 revenue (subscription +26%, perpetual -19%), " +
          "and preliminary FY2025 guidance puts it at ~68%. FY2025 results are not yet filed.",
      },
    ],
    question: "How do its margins compare with Acme Corp's?",
    notes:
      '"its" refers to Initech from the earlier turn. Initech gross margin ~74-75% vs Acme Corp ~38-40%; ' +
      "operating margin also higher at Initech. Latest filed year for Initech is FY2024.",
  },
  {
    id: "clarification-unresolved",
    history: [
      {
        question: "Compare Acme and Globex and tell me which one appears to be growing faster.",
        answer:
          'Which Acme do you mean: Acme Corp (ACME, industrial automation) or Acme Robotics (ACMR, collaborative robots)? They are unrelated companies.',
      },
    ],
    question: "not sure, whichever",
    notes:
      "The agent already asked and the reply doesn't resolve it, so it must NOT ask again. It should state an " +
      "assumption (or cover both Acmes briefly) and answer: Acme Robotics +47% and Acme Corp +5.5% in FY2025 " +
      "both beat Globex (+2.1%, ~0.6% organic).",
  },
];
