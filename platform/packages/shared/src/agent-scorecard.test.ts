import { describe, expect, it } from "vitest";

import {
  MIN_QUALITY_SAMPLE,
  MIN_RATE_SAMPLE,
  type AgentScorecard,
  avgCallSeconds,
  connectRate,
  csatIndex,
  fcrRate,
  focusAreas,
  headline,
  leadConversionRate,
  leadWinRate,
  loadHeadline,
  paceLabel,
  qaScore,
  rate,
  showTracker,
  slaCompliance,
  standing,
  taskCompliance,
  trackerFill,
  workQueue,
} from "./agent-scorecard";

/** A card with everything healthy and well-sampled; each test spoils one part. */
function card(over: Partial<AgentScorecard> = {}): AgentScorecard {
  return {
    telecallerId: "t1",
    displayName: "Asha",
    from: "2026-09-01",
    to: "2026-09-30",
    calls: 100,
    connected: 60,
    talkSeconds: 9000,
    activeDays: 20,
    days: [],
    qaScore: 80,
    qaScoredCalls: 50,
    qaCriteria: {
      consentRate: 1,
      scriptAdherence: 8,
      professionalism: 8,
      conversionSignal: 8,
    },
    sopAdherence: 85,
    sopScoredCalls: 50,
    sentiment: { positive: 30, neutral: 20, negative: 10 },
    sentimentReadCalls: 60,
    fcrEligibleCalls: 40,
    fcrResolvedCalls: 20,
    fcrConfigured: true,
    pipeline: { leadsWorked: 50, won: 10, lost: 15, open: 25, wonValue: 500_000 },
    // Nothing overdue and nothing due today: the fixture is the HEALTHY card, and
    // `workQueue` is asserted to be empty on it. The compliance tests pass their
    // own counts in, so the ratio does not need a failure planted here.
    tasks: { linked: true, completed: 18, overdue: 0, dueToday: 0, openTotal: 9 },
    sla: {
      breached: 0,
      open: 25,
      worstDays: null,
      worstStage: null,
      thresholdDays: 14,
      unanswered: 0,
    },
    today: { day: "2026-09-30", calls: 30, connected: 18, pace: 40, paceSource: "floor", inRange: true },
    peer: {
      calls: 100,
      connectRate: 0.6,
      avgCallSeconds: 150,
      qaScore: 80,
      csat: 60,
      fcrRate: 0.5,
      conversionRate: 0.2,
      callsPerActiveDay: 40,
    },
    ...over,
  };
}

describe("rate", () => {
  it("computes a share over a sufficient base", () => {
    expect(rate(3, 10)).toBeCloseTo(0.3);
  });

  it("refuses a base under the sample floor rather than returning zero", () => {
    expect(rate(1, MIN_RATE_SAMPLE - 1)).toBeNull();
  });

  it("refuses a zero base instead of dividing by it", () => {
    expect(rate(0, 0)).toBeNull();
  });
});

describe("connectRate", () => {
  it("is connected over dialled", () => {
    expect(connectRate(card())).toBeCloseTo(0.6);
  });

  it("is null for a rep who has barely started the day", () => {
    expect(connectRate(card({ calls: 3, connected: 2 }))).toBeNull();
  });
});

describe("avgCallSeconds", () => {
  it("divides by CONNECTED calls, not by every dial", () => {
    // 9000s over 60 connected is 150s. Over all 100 calls it would read 90s -
    // the bug this guards, where dialling more drags the average down.
    expect(avgCallSeconds(card())).toBe(150);
  });

  it("is null when too few calls connected to average", () => {
    expect(avgCallSeconds(card({ connected: 2, talkSeconds: 300 }))).toBeNull();
  });
});

describe("csatIndex", () => {
  it("scores positive 100, neutral 50 and negative 0", () => {
    // 30 positive + 20 neutral over 60 read = (3000 + 1000) / 60 = 66.
    expect(csatIndex(card().sentiment)).toBe(66);
  });

  it("returns 100 only when every read call was positive", () => {
    expect(csatIndex({ positive: 10, neutral: 0, negative: 0 })).toBe(100);
  });

  it("does not collapse a competent neutral floor to near zero", () => {
    // The reason neutral is 50 and not 0: this floor is not failing.
    expect(csatIndex({ positive: 0, neutral: 20, negative: 0 })).toBe(50);
  });

  it("is null on a thin base", () => {
    expect(csatIndex({ positive: 2, neutral: 1, negative: 0 })).toBeNull();
  });
});

describe("fcrRate", () => {
  it("is resolved over eligible first contacts", () => {
    expect(fcrRate(card())).toBeCloseTo(0.5);
  });

  it("is NULL, not zero, when the tenant has marked no resolving outcome", () => {
    // The whole point of 0144: unconfigured must not read as a rep scoring 0%.
    const unset = card({ fcrConfigured: false, fcrResolvedCalls: 0 });
    expect(fcrRate(unset)).toBeNull();
  });

  it("is zero when configured and genuinely nothing resolved", () => {
    expect(fcrRate(card({ fcrResolvedCalls: 0 }))).toBe(0);
  });
});

describe("qaScore", () => {
  it("passes the mean through once the sample is large enough", () => {
    expect(qaScore(card())).toBe(80);
  });

  it("suppresses a mean drawn from too few scored calls", () => {
    expect(qaScore(card({ qaScoredCalls: MIN_QUALITY_SAMPLE - 1 }))).toBeNull();
  });
});

describe("standing", () => {
  it("calls a value within 10% of the median typical", () => {
    expect(standing(0.62, 0.6)).toBe("at");
  });

  it("reads a clear lead as above", () => {
    expect(standing(0.9, 0.6)).toBe("above");
  });

  it("inverts when less is better", () => {
    expect(standing(90, 150, false)).toBe("above");
  });

  it("is unknown rather than guessing when there is no floor to compare with", () => {
    expect(standing(0.6, null)).toBe("unknown");
  });
});

describe("focusAreas", () => {
  it("says nothing when every signal is healthy", () => {
    expect(focusAreas(card())).toEqual([]);
  });

  it("puts the recording notice first even against far more evidence", () => {
    const areas = focusAreas(
      card({
        qaCriteria: {
          consentRate: 0.4,
          scriptAdherence: 3,
          professionalism: 3,
          conversionSignal: 3,
        },
      }),
    );
    expect(areas[0]?.key).toBe("consent");
  });

  it("never returns more than three things to work on", () => {
    const areas = focusAreas(
      card({
        qaCriteria: {
          consentRate: 0.4,
          scriptAdherence: 2,
          professionalism: 2,
          conversionSignal: 2,
        },
        sentiment: { positive: 5, neutral: 15, negative: 40 },
        sentimentReadCalls: 60,
        fcrResolvedCalls: 4,
        connected: 20,
      }),
    );
    expect(areas).toHaveLength(3);
  });

  it("stays silent on quality when too few calls were scored", () => {
    const areas = focusAreas(
      card({
        qaScoredCalls: MIN_QUALITY_SAMPLE - 1,
        qaCriteria: {
          consentRate: 0,
          scriptAdherence: 1,
          professionalism: 1,
          conversionSignal: 1,
        },
      }),
    );
    expect(areas.map((a) => a.key)).not.toContain("script");
  });

  it("does not raise FCR when the tenant never configured it", () => {
    const areas = focusAreas(card({ fcrConfigured: false, fcrResolvedCalls: 0 }));
    expect(areas.map((a) => a.key)).not.toContain("fcr");
  });

  it("orders by how much evidence sits behind the signal", () => {
    const areas = focusAreas(
      card({
        // Connect rate rests on 100 calls; the negative-sentiment read on 60.
        connected: 20,
        sentiment: { positive: 5, neutral: 15, negative: 40 },
        sentimentReadCalls: 60,
      }),
    );
    expect(areas.map((a) => a.key)).toEqual(["connect", "sentiment"]);
  });
});

describe("headline", () => {
  it("states output, connect rate and quality when all are known", () => {
    expect(headline(card())).toBe("100 calls · 60% connected · quality 80/100.");
  });

  it("drops the parts it cannot support rather than inventing them", () => {
    expect(headline(card({ calls: 4, connected: 2, qaScoredCalls: 1 }))).toBe("4 calls.");
  });

  it("says so plainly when the range is empty", () => {
    expect(headline(card({ calls: 0 }))).toBe("No calls logged in this range yet.");
  });
});

describe("leadConversionRate / leadWinRate", () => {
  it("converts leads worked into wins", () => {
    expect(leadConversionRate(card().pipeline)).toBeCloseTo(0.2);
  });

  it("refuses a conversion rate below the same floor the desk-wide one uses", () => {
    const thin = card({ pipeline: { leadsWorked: 4, won: 1, lost: 1, open: 2, wonValue: 0 } });
    expect(leadConversionRate(thin.pipeline)).toBeNull();
  });

  it("takes win rate over leads closed either way, not over every lead", () => {
    // 10 won of 25 closed = 0.4, not 10/50.
    expect(leadWinRate(card().pipeline)).toBeCloseTo(0.4);
  });
});

describe("taskCompliance", () => {
  it("divides by promises whose time has come, never by every open task", () => {
    expect(taskCompliance({ completed: 18, overdue: 2 })).toBeCloseTo(0.9);
  });

  it("refuses to call an empty week perfect", () => {
    expect(taskCompliance({ completed: 0, overdue: 0 })).toBeNull();
  });

  it("reports a total miss as zero, which is different from nothing due", () => {
    expect(taskCompliance({ completed: 0, overdue: 3 })).toBe(0);
  });
});

describe("slaCompliance", () => {
  it("reports the share of the open book that is still moving", () => {
    expect(slaCompliance({ breached: 5, open: 25 })).toBeCloseTo(0.8);
  });

  it("refuses to call an empty book compliant", () => {
    expect(slaCompliance({ breached: 0, open: 0 })).toBeNull();
  });
});

describe("the daily tracker", () => {
  it("stays hidden when today is outside the range being read", () => {
    expect(showTracker(card({ today: { ...card().today, inRange: false } }).today)).toBe(false);
  });

  it("fills to the share of the pace reached", () => {
    expect(trackerFill(card().today)).toBeCloseTo(0.75);
  });

  it("clamps rather than overflowing its track", () => {
    expect(trackerFill({ ...card().today, calls: 400 })).toBe(1);
  });

  it("draws no bar at all when there is no pace to compare against", () => {
    expect(trackerFill({ ...card().today, pace: null, paceSource: null })).toBeNull();
  });

  it("names where the pace came from, every time", () => {
    expect(paceLabel("floor")).toBe("the floor's typical day");
    expect(paceLabel("own")).toBe("your own typical day");
    expect(paceLabel(null)).toBeNull();
  });
});

describe("workQueue", () => {
  it("is empty on a clean card, which the page states in words", () => {
    expect(workQueue(card())).toEqual([]);
  });

  it("puts a lead nobody answered above leads that merely went quiet", () => {
    const loaded = card({
      sla: { ...card().sla, unanswered: 1, breached: 9, worstDays: 40, worstStage: "Contacted" },
    });
    expect(workQueue(loaded).map((i) => i.key)).toEqual(["unanswered", "stalled"]);
  });

  it("puts overdue follow-ups above stalled leads and due-today last", () => {
    const loaded = card({
      tasks: { linked: true, completed: 0, overdue: 3, dueToday: 2, openTotal: 5 },
      sla: { ...card().sla, breached: 4, worstDays: 20, worstStage: "New" },
    });
    expect(workQueue(loaded).map((i) => i.key)).toEqual(["overdue", "stalled", "due-today"]);
  });

  it("says nothing about tasks for somebody with no platform login", () => {
    const unlinked = card({
      tasks: { linked: false, completed: 0, overdue: 0, dueToday: 0, openTotal: 0 },
    });
    expect(workQueue(unlinked)).toEqual([]);
  });

  it("omits the age clause rather than printing a null day count", () => {
    const loaded = card({ sla: { ...card().sla, breached: 2, worstDays: null } });
    expect(workQueue(loaded)[0]!.detail).not.toContain("null");
  });

  it("gives every item somewhere to go", () => {
    const loaded = card({
      sla: { ...card().sla, unanswered: 2, breached: 2, worstDays: 30, worstStage: "New" },
      tasks: { linked: true, completed: 0, overdue: 1, dueToday: 1, openTotal: 2 },
    });
    expect(workQueue(loaded).every((i) => i.href !== null)).toBe(true);
  });
});

describe("loadHeadline", () => {
  it("names both halves of what somebody is carrying", () => {
    expect(loadHeadline(card())).toBe("You are carrying 25 open leads and 9 open follow-ups.");
  });

  it("leaves the task half out entirely for an unlinked person", () => {
    const unlinked = card({
      tasks: { linked: false, completed: 0, overdue: 0, dueToday: 0, openTotal: 0 },
    });
    expect(loadHeadline(unlinked)).toBe("You are carrying 25 open leads.");
  });

  it("says nothing is open rather than reporting two zeroes", () => {
    const clear = card({
      sla: { ...card().sla, open: 0 },
      tasks: { linked: true, completed: 4, overdue: 0, dueToday: 0, openTotal: 0 },
    });
    expect(loadHeadline(clear)).toBe("Nothing open in your name right now.");
  });
});
