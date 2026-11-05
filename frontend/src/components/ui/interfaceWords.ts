// The words of the interface for the names the API uses. A label that is built at run time from an identifier (`terminalJobs`,
// `maintenance.jobs.reconciled`, `case.created`) goes through here, because the source scanner cannot see it
// (`req~frontend-nav-vocabulary-text~1`). The identifiers themselves, paths and fields stay as the API names them.

const SHOWN: Readonly<Record<string, string>> = {
  case: 'problem', cases: 'problems', job: 'run', jobs: 'runs', publication: 'published result', publications: 'published results',
};

/** `text` with the whole words case(s), job(s) and publication(s) replaced by problem(s), run(s) and published result(s), keeping the first letter's case. */
export function inInterfaceWords(text: string): string {
  return text.replace(/\b(cases?|jobs?|publications?)\b/gi, (word) => {
    const shown = SHOWN[word.toLowerCase()];
    return word === word.toUpperCase() && word.length > 1 ? shown.toUpperCase() : word.charAt(0) === word.charAt(0).toUpperCase() ? shown.charAt(0).toUpperCase() + shown.slice(1) : shown;
  });
}
