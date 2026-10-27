declare module 'inquirer' {
  export function prompt(questions: Array<Record<string, unknown>>): Promise<Record<string, unknown>>;
  const inquirer: { prompt: typeof prompt };
  export default inquirer;
}
