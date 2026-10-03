import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CaretDown,
  DownloadSimple,
  FileText,
  Info,
  LockSimple,
  MagnifyingGlass,
  Microphone,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  X,
  ArrowUpRight,
  Database,
  SealCheck,
  UsersThree,
  TreeStructure,
  ClockCounterClockwise,
  Trash,
  Eye,
  WarningCircle,
  Archive,
  Fingerprint,
  VideoCamera,
  LinkSimple,
} from "@phosphor-icons/react";
import { RecordingStudio } from "./RecordingStudio.jsx";
import { loadPrivacyAccess } from "./privacyAccess.js";
import { loadTeamsReadiness } from "./teamsIntegration.js";
import { loadCommitments } from "./commitments.js";
import { currentRecordEvidence } from "./currentRecordEvidence.js";
import { loadManagementBriefing } from "./managementBriefing.js";
import { downloadMeetingRecord } from "./meetingExport.js";

const rows = [
  {
    type: "Decision",
    item: "Approve Core 2.0 launch plan",
    details:
      "Proceed with phased rollout starting with limited release to design partners in November, followed by broader availability in January 2027, contingent on customer validation and security sign-off.",
    time: "00:12:34 – 00:16:20",
    quote: "Let’s move forward with the phased plan …",
    initials: "SP",
    owner: "Sarah Patel",
    role: "Head of Product",
    due: "Nov 15, 2026",
  },
  {
    type: "Decision",
    item: "Prioritize enterprise segment",
    details:
      "Focus go-to-market on enterprise customers in North America and EMEA. Defer SMB campaigns until Q2 2027.",
    time: "00:18:05 – 00:21:17",
    quote: "Enterprise gives us the best path to durable growth …",
    initials: "JM",
    owner: "James Miller",
    role: "Chief Revenue Officer",
    due: "Nov 1, 2026",
  },
  {
    type: "Decision",
    item: "Maintain 2026 operating margin ≥ 18%",
    details:
      "Reaffirm operating margin target and manage incremental investments within existing plan.",
    time: "00:24:10 – 00:26:03",
    quote: "We can support the investments and still be at 18% …",
    initials: "EP",
    owner: "Elena Park",
    role: "Chief Financial Officer",
    due: "Ongoing",
  },
  {
    type: "Open question",
    item: "Pricing for enterprise tier",
    details:
      "Confirm pricing structure and packaging before broader launch. Validate with design partners.",
    time: "00:29:42 – 00:31:58",
    quote: "We need one more pass on pricing …",
    initials: "SP",
    owner: "Sarah Patel",
    role: "Head of Product",
    due: "Oct 14, 2026",
  },
  {
    type: "Open question",
    item: "Security review timeline",
    details:
      "Need confirmation from Security on review timeline and any required changes.",
    time: "00:32:11 – 00:34:06",
    quote: "Security is still assessing …",
    initials: "DR",
    owner: "Daniel Ruiz",
    role: "Chief Information Officer",
    due: "Oct 9, 2026",
  },
  {
    type: "Risk",
    item: "Execution risk on enterprise ramp",
    details:
      "Hiring, enablement, and customer references are critical path items. Slippage could impact revenue targets.",
    time: "00:36:50 – 00:39:12",
    quote: "The risk is execution …",
    initials: "JM",
    owner: "James Miller",
    role: "Chief Revenue Officer",
    due: "—",
  },
  {
    type: "Risk",
    item: "Dependency on key hires",
    details:
      "Enterprise sales hiring must be complete by year-end to support Q1 pipeline.",
    time: "00:41:03 – 00:43:27",
    quote: "We need the hires in place …",
    initials: "JM",
    owner: "James Miller",
    role: "Chief Revenue Officer",
    due: "Dec 31, 2026",
  },
];
const transcript = [
  {
    time: "00:12:34",
    speaker: "Sarah Patel",
    text: "Let’s move forward with the phased plan. We’ll start with the design partners in November and use their feedback as the release gate.",
  },
  {
    time: "00:14:08",
    speaker: "Elena Park",
    text: "That keeps the investment inside the operating plan, provided the security review closes before the broader launch.",
  },
  {
    time: "00:16:20",
    speaker: "Sarah Patel",
    text: "Agreed. January remains contingent on customer validation and security sign-off.",
  },
];
const knowledgeThreads = [
  {
    id: "core-launch",
    type: "Decision",
    title: "Core 2.0 launch plan",
    meeting: "Q4 Product & Go-to-Market Review",
    date: "Sep 30, 2026",
    snippet:
      "The team approved a phased rollout with design partners in November and broader availability in January, pending customer validation and security sign-off.",
    tags: ["Core 2.0", "Launch", "Product"],
    citation: rows[0],
  },
  {
    id: "margin",
    type: "Decision",
    title: "2026 operating margin guardrail",
    meeting: "Q4 Product & Go-to-Market Review",
    date: "Sep 30, 2026",
    snippet:
      "Incremental investments remain inside the operating plan while preserving the 18% operating margin target.",
    tags: ["Finance", "Margin", "Planning"],
    citation: rows[2],
  },
  {
    id: "security",
    type: "Open question",
    title: "Security review before broad launch",
    meeting: "Q4 Product & Go-to-Market Review",
    date: "Sep 30, 2026",
    snippet:
      "Security sign-off is a launch dependency. The review timeline and any required changes remain open for confirmation.",
    tags: ["Security", "Dependency", "Core 2.0"],
    citation: rows[4],
  },
  {
    id: "enterprise-ramp",
    type: "Risk",
    title: "Enterprise ramp execution risk",
    meeting: "Q4 Product & Go-to-Market Review",
    date: "Sep 30, 2026",
    snippet:
      "Hiring, enablement, and customer references are the critical path for the enterprise motion and Q1 pipeline.",
    tags: ["Revenue", "Hiring", "Risk"],
    citation: rows[5],
  },
];
const accessPaths = [
  {
    kind: "Participant",
    icon: UsersThree,
    name: "Meeting participants",
    detail:
      "Can view this meeting's transcript, intelligence, and action items.",
    state: "Scoped to this record",
    tone: "granted",
  },
  {
    kind: "Executive",
    icon: TreeStructure,
    name: "Management chain",
    detail:
      "Executive Leadership inherits read-only access under Leadership hierarchy v4.",
    state: "Policy-derived",
    tone: "derived",
  },
  {
    kind: "Excluded",
    icon: LockSimple,
    name: "All other employees",
    detail: "Not discoverable in search, APIs, or agent workflows.",
    state: "No standing access",
    tone: "blocked",
  },
];
const auditEvents = [
  {
    time: "11:42:18 PT",
    actor: "Avery Chen",
    event: "Opened decision ledger",
    path: "Executive Leadership · inherited read",
    outcome: "Allowed",
  },
  {
    time: "11:42:19 PT",
    actor: "Knowledge retrieval",
    event: "Evaluated authorized scope",
    path: "Policy engine · 4 meeting threads",
    outcome: "Allowed",
  },
  {
    time: "11:18:04 PT",
    actor: "Maya Torres",
    event: "Viewed cited transcript",
    path: "Participant · direct meeting access",
    outcome: "Allowed",
  },
  {
    time: "10:02:07 PT",
    actor: "Capture policy",
    event: "Recorded consent posture",
    path: "12 participants · policy v4",
    outcome: "Sealed",
  },
];

function TypeMark({ type }) {
  return (
    <span className={`type type-${type.toLowerCase().replace(" ", "-")}`}>
      <i />
      {type}
    </span>
  );
}

const postureLabel = (posture) =>
  posture === "management-chain" ? "Management chain" : "Participant";
const privacyClassificationLabel = (classification) =>
  `${classification.confidentiality.replace("-", " ")} · ${classification.recordingProhibited ? "recording prohibited" : "recording permitted"}`;
const privacyTime = (value) =>
  value
    ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "Recorded time";
const retentionLabel = (state) =>
  ({ active: "Active", "pending-deletion": "Pending deletion", "deletion-in-progress": "Deletion in progress", deleted: "Deleted" })[state] ?? "Unavailable";
const deletionLabel = (state) =>
  ({ "not-requested": "Not requested", scheduled: "Scheduled", "in-progress": "In progress", completed: "Completed" })[state] ?? "Unavailable";
const auditActionLabel = (action) =>
  action === "redacted-event" ? "Redacted audit event" : action.replaceAll(".", " ");
const commitmentStatusLabel = (status) =>
  ({
    open: "Open",
    "in-progress": "In progress",
    blocked: "Blocked",
    completed: "Completed",
    cancelled: "Cancelled",
  })[status] ?? "Unavailable";
const commitmentDeadlineLabel = (deadline) =>
  deadline
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(deadline))
    : "No deadline recorded";

export function App() {
  const [view, setView] = useState("ledger");
  const [filter, setFilter] = useState("All items");
  const [filterOpen, setFilterOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [accessTab, setAccessTab] = useState("controls");
  const [privacyAccess, setPrivacyAccess] = useState({ status: "idle" });
  const [demoRetentionState, setDemoRetentionState] = useState("Scheduled");
  const [demoDeleteState, setDemoDeleteState] = useState("Available");
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [commitmentsOpen, setCommitmentsOpen] = useState(false);
  const [commitments, setCommitments] = useState({ status: "idle" });
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [managementBriefing, setManagementBriefing] = useState({ status: "idle" });
  const [commitmentQuery, setCommitmentQuery] = useState("");
  const [commitmentFilter, setCommitmentFilter] = useState("all");
  const [teamsOpen, setTeamsOpen] = useState(false);
  const [teamsReadiness, setTeamsReadiness] = useState({ status: "idle" });
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [transcriptQuery, setTranscriptQuery] = useState("");
  const [activeCitation, setActiveCitation] = useState(rows[0]);
  const visibleRows = useMemo(
    () =>
      filter === "All items" ? rows : rows.filter((row) => row.type === filter),
    [filter],
  );
  const visibleKnowledge = useMemo(() => {
    const query = knowledgeQuery.trim().toLowerCase();
    if (!query) return knowledgeThreads;
    return knowledgeThreads.filter((thread) =>
      [thread.title, thread.meeting, thread.snippet, ...thread.tags]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [knowledgeQuery]);
  const visibleTranscript = useMemo(() => {
    const query = transcriptQuery.trim().toLowerCase();
    if (!query) return transcript;
    return transcript.filter((line) =>
      `${line.time} ${line.speaker} ${line.text}`.toLowerCase().includes(query),
    );
  }, [transcriptQuery]);
  const openTranscript = (row = rows[0]) => {
    setActiveCitation(row);
    setTranscriptQuery("");
    setTranscriptOpen(true);
  };
  const openKnowledge = () => {
    setKnowledgeQuery("");
    setKnowledgeOpen(true);
  };
  const openCommitments = () => {
    setCommitmentQuery("");
    setCommitmentFilter("all");
    setCommitmentsOpen(true);
  };
  const openManagementBriefing = () => {
    setBriefingOpen(true);
  };
  const openPrivacyAccess = () => {
    setAccessTab("controls");
    setAccessOpen(true);
  };
  const openTeams = () => {
    setTeamsOpen(true);
  };
  const openBriefingEvidence = (item) => {
    const evidence = currentRecordEvidence(item.source.meetingId, item.source.citations);
    if (!evidence) return;
    setBriefingOpen(false);
    openTranscript({
      item: item.text,
      time: "Authorized transcript source",
      quote: "Evidence is available in this authorized meeting record.",
    });
  };

  const privacyData = privacyAccess.status === "authorized" ? privacyAccess.data : null;
  const privacyLoading = privacyAccess.status === "idle" || privacyAccess.status === "loading";
  const privacyUsesDemo = privacyAccess.status === "demo";
  const privacyUnavailable = privacyAccess.status === "unavailable";
  const privacyClassification = privacyData?.classification ?? {
    confidentiality: "confidential",
    recordingProhibited: false,
  };
  const retentionState = privacyData
    ? retentionLabel(privacyData.retention.state)
    : demoRetentionState;
  const deleteState = privacyData
    ? deletionLabel(privacyData.retention.deletion)
    : demoDeleteState;
  const dynamicAccessPaths = privacyData
    ? [{
      kind: "Authorized path",
      icon: privacyData.access.posture === "management-chain" ? TreeStructure : UsersThree,
      name: postureLabel(privacyData.access.posture),
      detail: privacyData.access.posture === "management-chain"
        ? "Read access is granted by the approved management hierarchy."
        : "Read access is granted because you are a meeting participant.",
      state: "Authorized",
      tone: "granted",
    }]
    : accessPaths;
  const privacyAuditEvents = privacyData
    ? privacyData.auditTimeline
    : auditEvents.map(() => ({
      occurredAt: null,
      action: "redacted-event",
      outcome: "redacted",
      reason: "REDACTED",
      immutable: true,
    }));
  const teamsData = teamsReadiness.status === "ready" ? teamsReadiness.data : null;
  const teamsConfigurationCount = teamsData
    ? [teamsData.clientIdConfigured, teamsData.tenantConfigured, teamsData.redirectUriConfigured]
      .filter(Boolean).length
    : 0;
  const commitmentRows = commitments.status === "authorized" ? commitments.data.commitments : [];
  const visibleCommitments = useMemo(
    () => commitmentFilter === "all"
      ? commitmentRows
      : commitmentRows.filter((item) => item.status === commitmentFilter),
    [commitmentFilter, commitmentRows],
  );
  const briefingData = managementBriefing.status === "authorized" ? managementBriefing.data.briefing : null;

  useEffect(() => {
    if (!accessOpen) return undefined;
    let active = true;
    setPrivacyAccess({ status: "loading" });
    loadPrivacyAccess().then((result) => {
      if (active) setPrivacyAccess(result);
    });
    return () => {
      active = false;
    };
  }, [accessOpen]);

  useEffect(() => {
    if (!teamsOpen) return undefined;
    let active = true;
    setTeamsReadiness({ status: "loading" });
    loadTeamsReadiness().then((result) => {
      if (active) setTeamsReadiness(result);
    });
    return () => { active = false; };
  }, [teamsOpen]);

  useEffect(() => {
    if (!commitmentsOpen) return undefined;
    let active = true;
    setCommitments({ status: "loading" });
    loadCommitments({ query: commitmentQuery }).then((result) => {
      if (active) setCommitments(result);
    });
    return () => { active = false; };
  }, [commitmentsOpen, commitmentQuery]);

  useEffect(() => {
    if (!briefingOpen) return undefined;
    let active = true;
    setManagementBriefing({ status: "loading" });
    loadManagementBriefing().then((result) => {
      if (active) setManagementBriefing(result);
    });
    return () => { active = false; };
  }, [briefingOpen]);

  if (view === "recording")
    return <RecordingStudio onBack={() => setView("ledger")} />;

  return (
    <main className="app-shell">
      <header className="record-header">
        <div className="breadcrumbs">
          MEETINGS <span>/</span> EXECUTIVE RECORDS <span>/</span> SEPTEMBER 30,
          2026
        </div>
        <div className="header-grid">
          <section className="title-block">
            <h1>Q4 Product &amp; Go-to-Market Review</h1>
            <div className="meeting-meta">
              <span>September 30, 2026</span>
              <span>10:00 AM – 11:30 AM (PT)</span>
              <span>Executive Leadership</span>
              <span>Virtual</span>
            </div>
            <button className="knowledge-trigger" onClick={openKnowledge}>
              <Database size={15} /> Search authorized knowledge{" "}
              <ArrowUpRight size={14} />
            </button>
            <button className="commitments-trigger" onClick={openCommitments}>
              <FileText size={15} /> Review authorized commitments{" "}
              <ArrowUpRight size={14} />
            </button>
            <button className="briefing-trigger" onClick={openManagementBriefing}>
              <SealCheck size={15} /> Management briefing{" "}
              <ArrowUpRight size={14} />
            </button>
          </section>
          <section className="classification">
            <strong>CONFIDENTIAL</strong>
            <p>Exec Leadership, Product, Finance</p>
            <small>
              12 participants&nbsp; · &nbsp;Recorded and transcribed
            </small>
          </section>
          <button
            className="access-card"
            onClick={openPrivacyAccess}
            aria-haspopup="dialog"
          >
            <LockSimple size={25} weight="light" />
            <span>
              <b>You have access</b>
              <small>
                You’re a member of the Executive Leadership group, which has
                access to this meeting and its content.
              </small>
              <em>
                View access details <ArrowRight size={14} />
              </em>
            </span>
          </button>
          <button className="integration-card" onClick={openTeams} aria-haspopup="dialog">
            <VideoCamera size={24} weight="light" />
            <span>
              <b>Microsoft Teams</b>
              <small>Selected first integration · secure connection setup required</small>
            </span>
          </button>
        </div>
      </header>
      <section className="summary-section">
        <div className="summary-copy">
          <h2>Executive summary</h2>
          <p>
            The executive team aligned on a focused Q4 plan to launch Core 2.0,
            prioritize enterprise segments, and maintain discipline on margins.
            Go-to-market will center on a limited release in November, with
            expanded availability in January pending customer validation.
            Several dependencies remain, including security review, hiring for
            enterprise sales, and final pricing. The team acknowledged execution
            risk but agreed the plan positions the company for durable growth in
            2027 if key milestones are met.
          </p>
        </div>
        <div className="takeaways">
          <h3>KEY TAKEAWAYS</h3>
          <ul>
            <li>Approved Core 2.0 launch plan with phased rollout</li>
            <li>Target enterprise segment as primary motion</li>
            <li>Maintain 2026 operating margin ≥ 18%</li>
            <li>
              Resolve open items on security review, enterprise hiring, and
              pricing
            </li>
            <li>Revisit progress at the October 28 executive meeting</li>
          </ul>
        </div>
      </section>
      <section className="ledger-section">
        <div className="ledger-heading">
          <div>
            <h2>Decision ledger</h2>
            <p>
              Decisions, open questions, risks, and actions from this meeting
              with citations to the transcript.
            </p>
          </div>
          <div className="confidence">
            <span>
              AI-generated content&nbsp; · &nbsp;Review for accuracy{" "}
              <Info size={16} />
            </span>
            <div>
              <i>
                <b />
              </i>{" "}
              High confidence (86%)
            </div>
          </div>
        </div>
        <div className="ledger-tools">
          <div className="filter-wrap">
            <button
              className="filter-button"
              onClick={() => setFilterOpen(!filterOpen)}
              aria-expanded={filterOpen}
            >
              <SlidersHorizontal size={16} /> {filter} <CaretDown size={14} />
            </button>
            {filterOpen && (
              <div className="filter-menu">
                {["All items", "Decision", "Open question", "Risk"].map(
                  (name) => (
                    <button
                      key={name}
                      className={filter === name ? "selected" : ""}
                      onClick={() => {
                        setFilter(name);
                        setFilterOpen(false);
                      }}
                    >
                      {name}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
          <span>{visibleRows.length} ledger entries</span>
        </div>
        <div className="ledger-table" role="table">
          <div className="table-head" role="row">
            <span>TYPE</span>
            <span>ITEM</span>
            <span>DETAILS AND CONTEXT</span>
            <span>CITATION</span>
            <span>OWNER</span>
            <span>DUE DATE</span>
          </div>
          {visibleRows.map((row) => (
            <div className="table-row" role="row" key={row.item}>
              <div>
                <TypeMark type={row.type} />
              </div>
              <div className="item">{row.item}</div>
              <div className="details">{row.details}</div>
              <button className="citation" onClick={() => openTranscript(row)}>
                <Play size={15} weight="fill" />
                <span>
                  <b>{row.time}</b>
                  <small>“{row.quote}”</small>
                </span>
              </button>
              <div className="owner">
                <span>{row.initials}</span>
                <div>
                  <b>{row.owner}</b>
                  <small>{row.role}</small>
                </div>
              </div>
              <div className="due">{row.due}</div>
            </div>
          ))}
        </div>
      </section>
      <footer className="action-bar">
        <button className="primary-action" onClick={() => setView("recording")}>
          <Microphone size={17} weight="fill" /> Test secure recording
        </button>
        <button className="transcript-action" onClick={() => openTranscript()}>
          <Play size={16} weight="fill" /> Cited transcript
        </button>
        <button className="knowledge-action" onClick={openKnowledge}>
          <Database size={16} /> Authorized knowledge
        </button>
        <button className="commitments-action" onClick={openCommitments}>
          <FileText size={16} /> Commitments
        </button>
        <button className="briefing-action" onClick={openManagementBriefing}>
          <SealCheck size={16} /> Management briefing
        </button>
        <button
          className="privacy-action"
          onClick={openPrivacyAccess}
        >
          <ShieldCheck size={16} /> Privacy &amp; access
        </button>
        <button className="integration-action" onClick={openTeams}>
          <VideoCamera size={16} /> Teams readiness
        </button>
        <button
          className="download-action"
          onClick={async () => {
            const result = await downloadMeetingRecord();
            if (!result.ok) window.alert(result.message);
          }}
        >
          <DownloadSimple size={19} /> Download meeting record
        </button>
        <span>
          <FileText size={17} /> Development capture keeps audio in this browser
          only
        </span>
      </footer>
      {accessOpen && (
        <div className="overlay" onMouseDown={() => setAccessOpen(false)}>
          <aside
            className="access-panel privacy-panel"
            onMouseDown={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Privacy and access management"
          >
            <button className="close" onClick={() => setAccessOpen(false)}>
              <X size={20} />
            </button>
            <div className="privacy-heading">
              <div className="panel-icon">
                <ShieldCheck size={28} />
              </div>
              <div>
                <p className="eyebrow">PRIVACY CONTROL PLANE</p>
                <h2>Access with evidence</h2>
                <p>
                  Every view is scoped to the meeting policy, its participants,
                  and the approved management chain.
                </p>
              </div>
            </div>
            {privacyLoading ? (
              <div className="privacy-state" role="status">
                <ClockCounterClockwise size={24} />
                <p className="eyebrow">CHECKING AUTHORIZED SCOPE</p>
                <h3>Loading privacy controls</h3>
                <p>We are confirming whether this record can be shown in your authorized scope.</p>
              </div>
            ) : privacyUnavailable ? (
              <div className="privacy-state privacy-unavailable" role="status">
                <LockSimple size={24} />
                <p className="eyebrow">PRIVACY DETAILS UNAVAILABLE</p>
                <h3>No record details are shown</h3>
                <p>This view does not reveal whether a meeting exists or why details could not be displayed.</p>
              </div>
            ) : (
              <>
                <div className="privacy-tabs" role="tablist" aria-label="Privacy views">
                  <button role="tab" aria-selected={accessTab === "controls"} className={accessTab === "controls" ? "selected" : ""} onClick={() => setAccessTab("controls")}>Access controls</button>
                  <button role="tab" aria-selected={accessTab === "audit"} className={accessTab === "audit" ? "selected" : ""} onClick={() => setAccessTab("audit")}><ClockCounterClockwise size={14} /> Audit history</button>
                </div>
                {privacyUsesDemo && <div className="privacy-demo-banner" role="status"><WarningCircle size={16} /><span><b>Demo fallback</b> — live privacy data is unavailable; the examples below are not meeting records.</span></div>}
                {accessTab === "controls" ? (
              <div className="privacy-scroll">
                <section className="privacy-posture">
                  <div>
                    <span className="posture-icon">
                      <WarningCircle size={18} />
                    </span>
                    <p className="eyebrow">RECORDING POSTURE</p>
                    <h3>{privacyClassificationLabel(privacyClassification)}</h3>
                    <p>
                      This meeting passed its pre-capture policy check.
                      Never-record categories are evaluated before a microphone
                      can be opened.
                    </p>
                  </div>
                  <span className="posture-status">
                    {privacyUsesDemo ? "Demo policy only" : "Policy verified"}
                  </span>
                </section>
                <section className="privacy-section">
                  <div className="privacy-section-head">
                    <div>
                      <p className="eyebrow">WHO CAN ACCESS</p>
                      <h3>Permission paths</h3>
                    </div>
                    <Fingerprint size={20} />
                  </div>
                  <div className="access-paths">
                    {dynamicAccessPaths.map((path) => {
                      const Icon = path.icon;
                      return (
                        <article key={path.kind}>
                          <span className={`path-icon ${path.tone}`}>
                            <Icon size={18} />
                          </span>
                          <div>
                            <b>{path.name}</b>
                            <p>{path.detail}</p>
                            <small>{path.kind}</small>
                          </div>
                          <em className={path.tone}>{path.state}</em>
                        </article>
                      );
                    })}
                  </div>
                </section>
                <section className="privacy-section lifecycle-section">
                  <div className="privacy-section-head">
                    <div>
                      <p className="eyebrow">LIFECYCLE</p>
                      <h3>Retention &amp; deletion</h3>
                    </div>
                    <Archive size={20} />
                  </div>
                  <dl className="lifecycle-list">
                    <div>
                      <dt>Retention schedule</dt>
                      <dd>
                        <b>{retentionState}</b>
                        <small>Delete automatically on Sep 30, 2029</small>
                      </dd>
                      <button
                        disabled={!privacyUsesDemo}
                        onClick={() =>
                          setDemoRetentionState(
                            demoRetentionState === "Scheduled"
                              ? "Legal hold review"
                              : "Scheduled",
                          )
                        }
                      >
                        Review
                      </button>
                    </div>
                    <div>
                      <dt>Participant deletion request</dt>
                      <dd>
                        <b
                          className={
                            deleteState === "Queued" ? "danger-text" : ""
                          }
                        >
                          {deleteState}
                        </b>
                        <small>Requires policy review and audit evidence</small>
                      </dd>
                      <button
                        className="delete-control"
                        disabled={!privacyUsesDemo}
                        onClick={() =>
                          setDemoDeleteState(
                            demoDeleteState === "Available"
                              ? "Queued"
                              : "Available",
                          )
                        }
                      >
                        <Trash size={14} />{" "}
                        {deleteState === "Available" ? "Request" : "Undo"}
                      </button>
                    </div>
                  </dl>
                  <small className="lifecycle-note">
                    Prototype controls show state only. Production workflows
                    require the organization retention policy and legal review.
                  </small>
                </section>
                <section className="policy-foot">
                  <Eye size={16} />
                  <span>
                    <b>Search and agents inherit this policy.</b> No transcript
                    segment, citation, or derived intelligence is returned
                    outside an approved path.
                  </span>
                </section>
              </div>
            ) : (
              <div className="privacy-scroll audit-view">
                <section className="audit-intro">
                  <p className="eyebrow">TAMPER-EVIDENT ACCESS LEDGER</p>
                  <h3>Every read leaves a trace.</h3>
                  <p>
                    Entries are ordered by event time and chained to the record
                    policy. The prototype renders an immutable-style audit
                    trail.
                  </p>
                </section>
                <div className="audit-chain">
                  <span>MEETING RECORD</span>
                  <i />
                  <span>POLICY v4</span>
                  <i />
                  <span>EVENT HASH</span>
                </div>
                <div className="audit-events">
                  {privacyAuditEvents.map((event, index) => (
                    <article key={`${event.occurredAt ?? "redacted"}-${event.action}-${index}`}>
                      <div className="audit-index">
                        <i>
                          {String(privacyAuditEvents.length - index).padStart(2, "0")}
                        </i>
                        <span />
                      </div>
                      <div className="audit-event-main">
                        <div>
                          <time>{privacyTime(event.occurredAt)}</time>
                          <em>{event.outcome === "allowed" ? "Allowed" : "Redacted"}</em>
                        </div>
                        <h4>{auditActionLabel(event.action)}</h4>
                        <p>
                          {event.reason ?? "No additional details are disclosed"}
                        </p>
                      </div>
                      <LockSimple size={17} />
                    </article>
                  ))}
                </div>
                <section className="audit-seal">
                  <ShieldCheck size={20} />
                  <div>
                    <b>Audit seal intact</b>
                    <p>Hash chain: 8F3A · 92D1 · 6C7E · C4A9</p>
                  </div>
                </section>
              </div>
            )}
              </>
            )}
          </aside>
        </div>
      )}
      {transcriptOpen && (
        <div className="overlay" onMouseDown={() => setTranscriptOpen(false)}>
          <aside
            className="transcript-panel"
            onMouseDown={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Cited transcript"
          >
            <div className="drawer-head">
              <div>
                <p className="eyebrow">CITED TRANSCRIPT</p>
                <h2>{activeCitation.item}</h2>
                <span>{activeCitation.time}</span>
              </div>
              <button
                className="close"
                onClick={() => setTranscriptOpen(false)}
              >
                <X size={20} />
              </button>
            </div>
            <div className="search-box">
              <MagnifyingGlass size={18} />
              <input
                aria-label="Search transcript"
                placeholder="Search this transcript"
                value={transcriptQuery}
                onChange={(event) => setTranscriptQuery(event.target.value)}
              />
            </div>
            <div className="transcript-list">
              {visibleTranscript.length ? (
                visibleTranscript.map((line, idx) => (
                  <article
                    className={idx === 0 ? "active-line" : ""}
                    key={line.time}
                  >
                    <time>{line.time}</time>
                    <div>
                      <b>{line.speaker}</b>
                      <p>{line.text}</p>
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty-search">
                  <MagnifyingGlass size={22} />
                  <p>
                    No authorized transcript lines match “{transcriptQuery}”.
                  </p>
                </div>
              )}
            </div>
            <div className="drawer-foot">
              <ShieldCheck size={16} /> Authorized transcript excerpt · Speaker
              attribution preserved
            </div>
          </aside>
        </div>
      )}
      {knowledgeOpen && (
        <div
          className="overlay knowledge-overlay"
          onMouseDown={() => setKnowledgeOpen(false)}
        >
          <aside
            className="knowledge-panel"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
            aria-label="Authorized organizational knowledge"
          >
            <div className="knowledge-head">
              <div>
                <p className="eyebrow">AUTHORIZED KNOWLEDGE</p>
                <h2>Search the record</h2>
                <p>
                  Find decisions, risks, and dependencies across the meetings
                  you are permitted to access.
                </p>
              </div>
              <button className="close" onClick={() => setKnowledgeOpen(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="knowledge-scope">
              <SealCheck size={17} />
              <span>
                <b>Authorized scope</b>
                <small>Executive Leadership · Product · Finance</small>
              </span>
              <em>4 indexed threads</em>
            </div>
            <label className="knowledge-search">
              <MagnifyingGlass size={19} />
              <input
                autoFocus
                aria-label="Search authorized knowledge"
                placeholder="Search decisions, teams, or topics"
                value={knowledgeQuery}
                onChange={(event) => setKnowledgeQuery(event.target.value)}
              />
              <kbd>⌘ K</kbd>
            </label>
            <div className="knowledge-results">
              <div className="knowledge-results-head">
                <span>{visibleKnowledge.length} authorized results</span>
                <small>Every result inherits meeting permissions</small>
              </div>
              {visibleKnowledge.length ? (
                visibleKnowledge.map((thread) => (
                  <article className="knowledge-result" key={thread.id}>
                    <div className="knowledge-result-top">
                      <TypeMark type={thread.type} />
                      <span>{thread.date}</span>
                    </div>
                    <h3>{thread.title}</h3>
                    <p>{thread.snippet}</p>
                    <div className="knowledge-result-foot">
                      <span>
                        {thread.tags.map((tag) => (
                          <i key={tag}>{tag}</i>
                        ))}
                      </span>
                      <button
                        onClick={() => {
                          setKnowledgeOpen(false);
                          openTranscript(thread.citation);
                        }}
                      >
                        <Play size={13} weight="fill" /> Open evidence{" "}
                        <ArrowRight size={13} />
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty-search knowledge-empty">
                  <Database size={24} />
                  <h3>No authorized matches</h3>
                  <p>Try a team, topic, or decision from this meeting.</p>
                </div>
              )}
            </div>
            <div className="knowledge-foot">
              <ShieldCheck size={15} /> Retrieval is permission-aware. Sensitive
              or unrelated meetings never enter this view.
            </div>
          </aside>
        </div>
      )}
      {commitmentsOpen && (
        <div className="overlay knowledge-overlay" onMouseDown={() => setCommitmentsOpen(false)}>
          <aside
            className="knowledge-panel commitments-panel"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Authorized cross-meeting commitments"
          >
            <div className="knowledge-head">
              <div>
                <p className="eyebrow">AUTHORIZED COMMITMENTS</p>
                <h2>Commitments with a source.</h2>
                <p>
                  Review actions derived from meetings you are permitted to access.
                  Every result carries its own meeting policy and source citation.
                </p>
              </div>
              <button className="close" onClick={() => setCommitmentsOpen(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="knowledge-scope commitments-scope">
              <SealCheck size={17} />
              <span>
                <b>Authorized scope only</b>
                <small>Hidden, unrelated, and cross-tenant meetings are not disclosed here.</small>
              </span>
              <em>{commitments.status === "authorized" ? `${commitmentRows.length} visible` : "Checking"}</em>
            </div>
            <label className="knowledge-search">
              <MagnifyingGlass size={19} />
              <input
                autoFocus
                aria-label="Search authorized commitments"
                placeholder="Search commitments, owners, deadlines, or status"
                value={commitmentQuery}
                maxLength={120}
                onChange={(event) => setCommitmentQuery(event.target.value)}
              />
            </label>
            <div className="commitment-filters" aria-label="Filter authorized commitments">
              {[["all", "All"], ["open", "Open"], ["in-progress", "In progress"], ["blocked", "Blocked"], ["completed", "Completed"]].map(([value, label]) => (
                <button
                  key={value}
                  className={commitmentFilter === value ? "selected" : ""}
                  aria-pressed={commitmentFilter === value}
                  onClick={() => setCommitmentFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="knowledge-results commitments-results" aria-live="polite">
              {commitments.status === "loading" || commitments.status === "idle" ? (
                <div className="empty-search knowledge-empty" role="status">
                  <ClockCounterClockwise size={24} />
                  <h3>Checking authorized commitments</h3>
                  <p>Only the server-approved result set will be rendered.</p>
                </div>
              ) : commitments.status === "unavailable" ? (
                <div className="empty-search knowledge-empty" role="status">
                  <LockSimple size={24} />
                  <h3>Commitments unavailable</h3>
                  <p>No meeting or action details are shown when the authorized query cannot be verified.</p>
                </div>
              ) : visibleCommitments.length ? (
                visibleCommitments.map((item) => {
                  const evidence = currentRecordEvidence(item.meetingId, item.source.citations);
                  return (
                    <article className="commitment-result" key={item.id}>
                      <div className="commitment-result-top">
                        <span className={`commitment-status status-${item.status}`}>{commitmentStatusLabel(item.status)}</span>
                        <span>{item.source.citations.length} source {item.source.citations.length === 1 ? "citation" : "citations"}</span>
                      </div>
                      <h3>{item.text}</h3>
                      <dl className="commitment-details">
                        <div><dt>Owner</dt><dd>{item.ownerId ?? "Unassigned"}</dd></div>
                        <div><dt>Deadline</dt><dd>{commitmentDeadlineLabel(item.deadline)}</dd></div>
                        <div><dt>Status</dt><dd>{commitmentStatusLabel(item.status)}</dd></div>
                      </dl>
                      <div className="commitment-source">
                        <span><LinkSimple size={14} /> {evidence ? `Evidence linked to ${evidence.length} authorized transcript ${evidence.length === 1 ? "segment" : "segments"}` : "Evidence link unavailable for this record"}</span>
                        {evidence ? (
                          <button
                            onClick={() => {
                              setCommitmentsOpen(false);
                              openTranscript({
                                item: item.text,
                                time: `Source: ${evidence.join(", ")}`,
                                quote: "Evidence is available in this authorized meeting record.",
                              });
                            }}
                          >
                            <Play size={13} weight="fill" /> Open evidence <ArrowRight size={13} />
                          </button>
                        ) : (
                          <small>Open the authorized source meeting to inspect its evidence.</small>
                        )}
                      </div>
                    </article>
                  );
                })
              ) : (
                <div className="empty-search knowledge-empty">
                  <FileText size={24} />
                  <h3>No authorized commitments found</h3>
                  <p>This does not confirm that no commitments exist outside your authorized scope.</p>
                </div>
              )}
            </div>
            <div className="knowledge-foot">
              <ShieldCheck size={15} /> Commitment search, filters, and evidence links inherit source-meeting authorization.
            </div>
          </aside>
        </div>
      )}
      {briefingOpen && (
        <div className="overlay knowledge-overlay" onMouseDown={() => setBriefingOpen(false)}>
          <aside
            className="knowledge-panel briefing-panel"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Authorized management briefing"
          >
            <div className="knowledge-head">
              <div>
                <p className="eyebrow">AUTHORIZED MANAGEMENT BRIEFING</p>
                <h2>What needs executive attention.</h2>
                <p>
                  A concise briefing assembled only from meeting intelligence you are
                  authorized to read. Each item remains tied to its source record.
                </p>
              </div>
              <button className="close" onClick={() => setBriefingOpen(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="knowledge-scope briefing-scope">
              <SealCheck size={17} />
              <span>
                <b>Authorized source scope only</b>
                <small>Unrelated meetings, hidden metadata, and processor provenance are excluded.</small>
              </span>
            </div>
            <div className="knowledge-results briefing-results" aria-live="polite">
              {managementBriefing.status === "loading" || managementBriefing.status === "idle" ? (
                <div className="empty-search knowledge-empty" role="status">
                  <ClockCounterClockwise size={24} />
                  <h3>Preparing the authorized briefing</h3>
                  <p>Only server-approved categories will be rendered.</p>
                </div>
              ) : managementBriefing.status === "unavailable" ? (
                <div className="empty-search knowledge-empty" role="status">
                  <LockSimple size={24} />
                  <h3>Briefing unavailable</h3>
                  <p>No meeting, intelligence, or source details are shown when the authorized request cannot be verified.</p>
                </div>
              ) : (
                <>
                  {[
                    ["Decisions", briefingData.decisions, "decision"],
                    ["Risks", briefingData.risks, "risk"],
                    ["Blockers", briefingData.blockers, "blocker"],
                    ["Open actions", briefingData.actions, "action"],
                  ].map(([label, items, tone]) => (
                    <section className={`briefing-section briefing-${tone}`} key={label}>
                      <div className="briefing-section-head">
                        <span><i /> {label}</span>
                        <small>Authorized items only</small>
                      </div>
                      {items.length ? items.map((item) => {
                        const evidence = currentRecordEvidence(item.source.meetingId, item.source.citations);
                        return (
                          <article className="briefing-item" key={item.id}>
                            <div className="briefing-item-copy">
                              <h3>{item.text}</h3>
                              {"status" in item && (
                                <div className="briefing-action-details">
                                  <span className={`commitment-status status-${item.status}`}>{commitmentStatusLabel(item.status)}</span>
                                  <small>Owner: {item.ownerId ?? "Unassigned"}</small>
                                  <small>Deadline: {commitmentDeadlineLabel(item.deadline)}</small>
                                </div>
                              )}
                            </div>
                            <div className="briefing-source">
                              {evidence ? (
                                <>
                                  <span><LinkSimple size={14} /> Evidence linked to this authorized transcript</span>
                                  <button onClick={() => openBriefingEvidence(item)}>
                                    <Play size={13} weight="fill" /> Open evidence <ArrowRight size={13} />
                                  </button>
                                </>
                              ) : (
                                <span><LockSimple size={14} /> Evidence link unavailable for this record</span>
                              )}
                            </div>
                          </article>
                        );
                      }) : (
                        <div className="briefing-empty">No authorized items are available in this category.</div>
                      )}
                    </section>
                  ))}
                </>
              )}
            </div>
            <div className="knowledge-foot">
              <ShieldCheck size={15} /> Management briefings inherit the same source-meeting authorization as search and agents.
            </div>
          </aside>
        </div>
      )}
      {teamsOpen && (
        <div className="overlay" onMouseDown={() => setTeamsOpen(false)}>
          <aside className="access-panel integration-panel" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Microsoft Teams integration readiness">
            <button className="close" onClick={() => setTeamsOpen(false)}><X size={20} /></button>
            <div className="integration-heading">
              <div className="panel-icon"><VideoCamera size={28} /></div>
              <div>
                <p className="eyebrow">INTEGRATION FOUNDATION</p>
                <h2>Teams, with a trust boundary.</h2>
                <p>Microsoft Teams is the selected first integration. This prototype does not collect credentials, connect an account, or retrieve meeting content.</p>
              </div>
            </div>
            {teamsReadiness.status === "loading" || teamsReadiness.status === "idle" ? (
              <div className="privacy-state" role="status"><ClockCounterClockwise size={24} /><p className="eyebrow">CHECKING READINESS</p><h3>Loading connection posture</h3><p>Confirming the local server capability boundary.</p></div>
            ) : teamsReadiness.status === "ready" ? (
              <div className="integration-scroll">
                <section className="integration-posture">
                  <VideoCamera size={20} />
                  <div><p className="eyebrow">CONNECTION STATUS</p><h3>{teamsReadiness.data.status === "not-configured" ? "Not configured" : "Administrator setup required"}</h3><p>Connection remains inactive until a production administrator configures the server-side Entra application and secret manager.</p></div>
                  <span>Not connected</span>
                </section>
                <section className="teams-section teams-import-blocked">
                  <WarningCircle size={18} weight="fill" />
                  <div><p className="eyebrow">IMPORT BOUNDARY</p><h3>Recording import is unavailable</h3><p>This client cannot connect to Teams, retrieve a meeting, or import cloud-recording media. No meeting URL, token, recording URL, or audio can be entered here.</p></div>
                </section>
                <section className="teams-section">
                  <div className="teams-section-head"><div><p className="eyebrow">ADMINISTRATOR READINESS</p><h3>Production connection checklist</h3></div><span className="teams-progress">{teamsConfigurationCount}/3 non-secret values confirmed</span></div>
                  <ol className="teams-readiness-list">
                    <li className={teamsData.clientIdConfigured && teamsData.tenantConfigured ? "configured" : "pending"}><Fingerprint size={17} /><div><b>Register an Entra application</b><p>Configure the tenant ID and client ID server-side. This page only receives readiness flags, never the values.</p></div><em>{teamsData.clientIdConfigured && teamsData.tenantConfigured ? "Confirmed" : "Required"}</em></li>
                    <li className={teamsData.redirectUriConfigured ? "configured" : "pending"}><LinkSimple size={17} /><div><b>Approve an HTTPS redirect URI</b><p>Use a production HTTPS callback registered in Entra. Local or browser-provided callback values are not accepted.</p></div><em>{teamsData.redirectUriConfigured ? "Confirmed" : "Required"}</em></li>
                    <li className="pending"><SealCheck size={17} /><div><b>Grant Microsoft Graph permissions</b><p>An authorized tenant administrator must approve the least-privilege permissions required for the selected ingestion model.</p></div><em>Approval required</em></li>
                    <li className="pending"><LockSimple size={17} /><div><b>Reference a secret manager</b><p>Store the Entra client secret in an approved server-side secret manager and provide only a deploy-time reference.</p></div><em>Never paste</em></li>
                    <li className="pending"><ShieldCheck size={17} /><div><b>Verify source ownership and webhooks</b><p>Validate the meeting owner and notification subscription on the server before any future recording handoff.</p></div><em>Verification required</em></li>
                    <li className="pending"><Archive size={17} /><div><b>Confirm residency and retention</b><p>Document the Microsoft 365 data region, organizational retention policy, legal holds, and deletion workflow.</p></div><em>Policy required</em></li>
                  </ol>
                </section>
                <section className="teams-section teams-guardrails"><LinkSimple size={18} /><div><b>Secrets and media are outside this browser boundary.</b><p>OAuth tokens, client secrets, meeting URLs, recording URLs, and media bytes are intentionally rejected from this flow and never enter the audit trail.</p></div></section>
                <section className="teams-section"><p className="eyebrow">FUTURE SERVER HANDOFF</p><h3>Consent remains the first gate</h3><ol className="teams-steps"><li>Organizer chooses an approved meeting through a server-side integration.</li><li>Classification, retention, ownership, and each required participant consent are re-checked.</li><li>Only then may a future connector retrieve approved cloud-recording media for protected processing.</li></ol></section>
              </div>
            ) : (
              <div className="privacy-state privacy-unavailable" role="status"><LockSimple size={24} /><p className="eyebrow">READINESS UNAVAILABLE</p><h3>No connection details are shown</h3><p>The integration endpoint could not be verified. No Teams data has been requested or imported.</p></div>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
