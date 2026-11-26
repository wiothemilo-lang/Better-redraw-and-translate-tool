internal static class NativeProgress
{
    internal static Action<double, string>? Report { get; set; }
    internal static void Emit(double progress, string stage) => Report?.Invoke(progress, stage);
}
