// The data dictionary the model reads before it writes SQL.
//
// A model that sees only column names will happily write a plausible query
// that returns a wrong answer. The notes below are the kind of facts that
// prevent that: how "empty" is stored, what a status value means, what is NOT
// in the database. Replace them with the traps of YOUR data; a note is worth
// adding the moment a wrong number was nearly (or actually) shipped because of
// something a column name did not tell you.
//
// The examples describe the tables of the companion repository
// zero-cost-marketing-data-hub.
export const GENERAL_NOTES = Object.freeze([
  'Before the first real query against a table, call describe_table and look at a few rows with SELECT * ... LIMIT 3. Knowing the schema in general is not the same as checking it for the query you are about to write.',
  'Dates are ISO text (YYYY-MM-DD), so they sort and compare as text. Recent days may be missing: collectors only load days that have settled.',
  'Empty text dimensions are stored as an empty string, never NULL. Filter with = \'\' (or IS NULL OR = \'\'), not IS NULL alone.',
]);

export const TABLE_NOTES = Object.freeze({
  web_traffic_daily: Object.freeze([
    'One row per day, page, channel and device. Add rows up with SUM; do not average rates across rows.',
    'page_path is a canonical path: no host, query string or trailing slash, lower case, language prefix kept.',
  ]),
  search_queries_daily: Object.freeze([
    'One row per day, query, page and country. Clicks and impressions are counts; compute CTR as SUM(clicks) / SUM(impressions), never as an average of row CTRs.',
  ]),
  lead_outcomes_daily: Object.freeze([
    'Contains NO personal data: no names, e-mails or phones. A person cannot be looked up here, so finding nothing proves nothing about whether someone is recorded.',
    'Counts per day, page and status. Statuses change over time (open, won, lost), so recent days can still move.',
  ]),
  v_page_funnel_daily: Object.freeze([
    'One row per day and page, already joined across traffic, search and leads. Use this view for cross-source questions.',
    'Never join the raw tables to each other yourself: their grains differ, and the join multiplies rows so every SUM silently inflates.',
  ]),
});

export function notesFor(tableName, tableNotes = TABLE_NOTES) {
  return tableNotes[tableName] ?? [];
}

export function toolDescription(generalNotes = GENERAL_NOTES) {
  return generalNotes.map((note, index) => `${index + 1}. ${note}`).join(' ');
}
