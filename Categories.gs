// Category definitions supplied by the user. The archive field is retained as
// reference metadata only; this script never archives or moves messages.
const JEV_CATEGORIES = [
  {
    key: 'pending',
    label: 'Jev-Pending',
    description: 'A status update whose main purpose is that a person or organization still owes the recipient an outcome, such as an open support case, application decision, or promised follow-up. Use only while that external result is pending. A concrete request the recipient must handle belongs to its subject category and may also receive Follow Up; ordinary order tracking belongs in Transactions & Bookings.',
    archive: true,
  },
  {
    key: 'people-personal',
    label: 'Jev-People & Personal',
    description: 'Direct personal correspondence with friends, family, acquaintances, or local community contacts. Use for the human relationship or conversation, not automated social-network activity, workplace matters, or a commercial transaction.',
    archive: false,
  },
  {
    key: 'work-career',
    label: 'Jev-Work & Career',
    description: 'Professional work, workplace coordination, recruiting, job applications, career development, and employment matters. Use for the work or career purpose even when a message also asks for a task; use Health & Benefits for benefit or medical-plan content and Money & Official Records for formal tax or financial records.',
    archive: false,
  },
  {
    key: 'home-services',
    label: 'Jev-Home & Services',
    description: 'Home, property, household maintenance, and essential service accounts such as electricity, gas, water, internet, and phone providers. Use for bills, service changes, outages, and maintenance notices; use Transactions & Bookings for an order, payment receipt, or travel reservation.',
    archive: false,
  },
  {
    key: 'health-benefits',
    label: 'Jev-Health & Benefits',
    description: 'Medical care and health administration, including appointments, providers, prescriptions, insurance, and employee benefits. Use for health or benefits subject matter, not general workplace coordination or payment receipts.',
    archive: false,
  },
  {
    key: 'money-official-records',
    label: 'Jev-Money & Official Records',
    description: 'Financial account records and official correspondence such as bank or card statements, transaction and fraud alerts, taxes, government notices, and legal or identity documents. Use Transactions & Bookings for seller-issued receipts, purchases, reservations, and tickets; use Home & Services for household utility providers.',
    archive: false,
  },
  {
    key: 'transactions-bookings',
    label: 'Jev-Transactions & Bookings',
    description: 'Records and status updates for purchases, payments, invoices, subscriptions, deliveries, travel, event tickets, and reservations. Use for seller or booking-provider records; use Health & Benefits for medical appointments and Money & Official Records for statements and notices issued by banks, government, or legal authorities. Routine tracking stays here rather than Pending.',
    archive: true,
  },
  {
    key: 'accounts-security',
    label: 'Jev-Accounts & Security',
    description: 'Individual account or software-service events, including sign-in and verification codes, password resets, security alerts, access changes, and service usage or build notifications. Routine one-time codes need no action by themselves. Confirmed compromise or a specific problem that requires the recipient to secure an account may also receive Follow Up.',
    archive: false,
  },
  {
    key: 'news-promotions',
    label: 'Jev-News & Promotions',
    description: 'Bulk editorial, community-platform, or promotional content intended to inform, entertain, or market rather than report an individual account event. Includes newsletters, industry digests, product announcements, sales, specific shopping offers, and social-network activity notifications. Do not use for direct personal correspondence, account security events, or transaction records.',
    archive: true,
  },
];
