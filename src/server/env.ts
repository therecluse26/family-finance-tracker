import type { AiSettings } from "../ai/ai-view.ts";
import type {
  BankConnecting,
  ConnectionRemoving,
  ConnectionRepairing,
} from "../bank/connect-view.ts";
import type { PlaidSettings } from "../bank/plaid-view.ts";
import type { ChannelSettings, SmtpSettings } from "../notify/email-view.ts";
import type { PushSettings } from "../notify/push-view.ts";
import type { PictureRoutes } from "../pictures/picture-view.ts";
import type { AboutRoutes } from "./about-views.ts";
import type { AiBoxRoutes } from "./ai-box-views.ts";
import type { AlertRoutes } from "./alerts-views.ts";
import type { AppUrl } from "./app-url.ts";
import type { BackupRoutes } from "./backups-views.ts";
import type { BankViews } from "./bank-views.ts";
import type { BenchmarkRoutes } from "./benchmarks-views.ts";
import type { BudgetRoutes } from "./budgets-views.ts";
import type { CategoryRoutes } from "./category-views.ts";
import type { ChatRoutes } from "./chat-views.ts";
import type { ComingUpRoutes } from "./coming-up-views.ts";
import type { DataExportRoutes } from "./data-export-views.ts";
import type { GoalRoutes } from "./goals-views.ts";
import type { HouseholdRoutes } from "./household-views.ts";
import type { MasterKeyRoutes } from "./master-key-views.ts";
import type { MemberRoutes } from "./members-views.ts";
import type { MoneyMovementRoutes } from "./money-movement-views.ts";
import type { MonthlyReviewRoutes } from "./monthly-reviews-views.ts";
import type { NoticeRoutes } from "./notice-views.ts";
import type { ProposalRoutes } from "./proposals-views.ts";
import type { RecurringRoutes } from "./recurring-views.ts";
import type { ReviewRoutes } from "./review-views.ts";
import type { SetupRoutes } from "./setup-views.ts";
import type { TopMerchantRoutes } from "./top-merchants-views.ts";

// What the security check sets on every request it accepts, and the session check on every /api
// route outside /api/auth/ and /api/setup.
export type ServerEnv = {
  Variables: {
    appUrl: AppUrl;
    // The source address, or the client a trusted proxy names in X-Forwarded-For.
    clientAddress: string;
    // The Member signed in on the request: the auth module's SignedInMember. Written out here,
    // since the web app's type check reads this file and runs without Node's types.
    member: { id: string; name: string; email: string };
    // The Accounts, Transactions, and Connections in app.db, for the routes that list them.
    bank: BankViews;
    // The Plaid keys and the count of Plaid Items, for the routes under /api/plaid/.
    plaid: PlaidSettings;
    // Linking a new bank through Plaid, for the routes under /api/plaid/.
    plaidConnecting: BankConnecting;
    // Removing a Connection and deleting its history, for the routes under /api/connections/.
    removing: ConnectionRemoving;
    // Repair and Add accounts in update mode, for the routes under /api/connections/.
    repairing: ConnectionRepairing;
    // The wizard's step 3 and "Check my master key".
    masterKey: MasterKeyRoutes;
    // The wizard's steps 5 to 9, and the dashboard's "Finish setup" list.
    setup: SetupRoutes;
    // The open System notices.
    notices: NoticeRoutes;
    // The Review list.
    reviewList: ReviewRoutes;
    // The Household facts.
    household: HouseholdRoutes;
    // Transaction types and totals by type.
    moneyMovement: MoneyMovementRoutes;
    // A Member's Category for a Transaction, and the Category rules.
    categories: CategoryRoutes;
    // Recurring charges.
    recurring: RecurringRoutes;
    // The Alert list.
    alerts: AlertRoutes;
    // Settings, About: the version, the Source code link, and the Update check.
    about: AboutRoutes;
    // Settings, Backups and data: the backup folder, the last backup, and "Back up now".
    backups: BackupRoutes;
    // Settings, Backups and data: "Download my data".
    dataExport: DataExportRoutes;
    // Settings, Members: the Members, invite links, and removing a Member.
    members: MemberRoutes;
    // Each Category's Benchmark.
    benchmarks: BenchmarkRoutes;
    // Each Category's Budget for a month.
    budgets: BudgetRoutes;
    // Goals and their progress.
    goals: GoalRoutes;
    // The pictures on the picture menu, drawn from app.db.
    pictures: PictureRoutes;
    // "Coming up" on the dashboard.
    comingUp: ComingUpRoutes;
    // Top Merchants, ranked by Spending.
    topMerchants: TopMerchantRoutes;
    // The dashboard's AI box, "This week".
    aiBox: AiBoxRoutes;
    // Accept, Edit, Skip, and Undo on Proposals.
    proposals: ProposalRoutes;
    // The Reviews page: the past Monthly reviews and the plan's ticks.
    monthlyReviews: MonthlyReviewRoutes;
    // Chat threads, and their answers.
    chat: ChatRoutes;
    // The Household's AI provider, for the routes under /api/ai/.
    ai: AiSettings;
    // The Household's SMTP server and the test email, for the routes under /api/smtp/.
    smtp: SmtpSettings;
    // Each Member's own channels for Alerts and System notices.
    channels: ChannelSettings;
    // Web push and each Member's devices, for the routes under /api/push/.
    push: PushSettings;
  };
};
