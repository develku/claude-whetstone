// POSIX single-quote a value for a shell command line: wrap in single quotes, and close/escape/reopen
// any embedded single quote ('\''). The shell-injection fence used wherever a value is interpolated into
// a shell:true command. Zero dependencies so any module can import it without pulling in the driver/CLI.
export const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
