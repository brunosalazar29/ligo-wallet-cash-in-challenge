using System.Diagnostics;

var projectRoot = FindProjectRoot(AppContext.BaseDirectory);
if (projectRoot is null)
{
    Console.Error.WriteLine("No se encontró el proyecto Ligo Cash-In. Ejecuta este .exe desde la carpeta del proyecto o deja el archivo scripts/start-local.ps1 junto a él.");
    return 1;
}

var scriptPath = Path.Combine(projectRoot, "scripts", "start-local.ps1");
var start = new ProcessStartInfo
{
    FileName = "powershell.exe",
    WorkingDirectory = projectRoot,
    UseShellExecute = false,
    Arguments = $"-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"{scriptPath}\""
};

try
{
    using var process = Process.Start(start);
    if (process is null)
    {
        Console.Error.WriteLine("No se pudo iniciar PowerShell.");
        return 1;
    }
    process.WaitForExit();
    return process.ExitCode;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"No se pudo iniciar el backend: {ex.Message}");
    return 1;
}

static string? FindProjectRoot(string startPath)
{
    var current = new DirectoryInfo(startPath);
    while (current is not null)
    {
        if (File.Exists(Path.Combine(current.FullName, "package.json")) &&
            File.Exists(Path.Combine(current.FullName, "scripts", "start-local.ps1")))
        {
            return current.FullName;
        }
        current = current.Parent;
    }
    return null;
}
