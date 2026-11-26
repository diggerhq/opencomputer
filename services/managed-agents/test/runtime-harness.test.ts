import { describe, expect, it } from "vitest";

import {
  formatQuestions,
  promptToolOverrides,
  questionAnswers,
} from "../src/runtime/harness.js";

describe("hosted runtime tool policy", () => {
  it("honors an explicitly disabled question tool", () => {
    expect(promptToolOverrides({ tools: { question: true } })).toEqual({
      question: true,
    });
  });

  it("removes tools denied by the deployed agent", () => {
    expect(
      promptToolOverrides({
        tools: { calendar_create_time_off: true },
        permission: {
          bash: "deny",
          calendar_create_time_off: "allow",
        },
      }),
    ).toEqual({
      bash: false,
      calendar_create_time_off: true,
      question: false,
    });
  });

  it("renders interactive questions into ordinary chat", () => {
    const questions = [
      {
        header: "Calendar",
        question: "Which calendar should I use?",
        options: [
          { label: "Personal", description: "Use your personal calendar." },
          { label: "Work", description: "Use your work calendar." },
        ],
      },
    ];
    expect(formatQuestions(questions)).toBe(
      "Which calendar should I use?\n" +
        "- Personal: Use your personal calendar.\n" +
        "- Work: Use your work calendar.",
    );
    expect(questionAnswers(questions, "work please")).toEqual([
      ["work please"],
    ]);
  });
});
