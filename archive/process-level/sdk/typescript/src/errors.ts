/**
 * Custom error classes for the OpenComputer SDK.
 */

/**
 * Base error class for OpenComputer errors.
 */
export class OpenComputerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenComputerError';
  }
}

/**
 * Error thrown when a sandbox session is not found.
 */
export class SandboxNotFoundError extends OpenComputerError {
  constructor(message = 'Sandbox session not found') {
    super(message);
    this.name = 'SandboxNotFoundError';
  }
}

/**
 * Error thrown when connection to the sandbox server fails.
 */
export class ConnectionError extends OpenComputerError {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/**
 * Error thrown when a command execution fails.
 */
export class CommandExecutionError extends OpenComputerError {
  /** Exit code of the failed command */
  exitCode: number;
  /** Standard output from the command */
  stdout: string;
  /** Standard error from the command */
  stderr: string;

  constructor(message: string, exitCode = 1, stdout = '', stderr = '') {
    super(message);
    this.name = 'CommandExecutionError';
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Error thrown when a file operation fails.
 */
export class FileOperationError extends OpenComputerError {
  constructor(message: string) {
    super(message);
    this.name = 'FileOperationError';
  }
}
