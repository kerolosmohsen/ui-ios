declare module 'picomatch' {
  function picomatch(pattern: string, options?: { dot?: boolean }): (value: string) => boolean;
  export default picomatch;
}
