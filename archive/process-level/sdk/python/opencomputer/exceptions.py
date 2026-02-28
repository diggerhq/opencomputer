"""Custom exceptions for the OpenComputer SDK."""


class OpenComputerError(Exception):
    """Base exception for OpenComputer errors."""
    pass


class SandboxNotFoundError(OpenComputerError):
    """Raised when a sandbox session is not found."""
    pass


class SandboxConnectionError(OpenComputerError):
    """Raised when connection to the sandbox server fails."""
    pass


class CommandExecutionError(OpenComputerError):
    """Raised when a command execution fails."""

    def __init__(self, message: str, exit_code: int = 1, stdout: str = "", stderr: str = ""):
        super().__init__(message)
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr


class FileOperationError(OpenComputerError):
    """Raised when a file operation fails."""
    pass
