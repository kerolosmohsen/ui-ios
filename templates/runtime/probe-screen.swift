import UIKit

@main
final class ProbeAppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting session: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Screen probe", sessionRole: session.role)
        configuration.delegateClass = ProbeSceneDelegate.self
        return configuration
    }
}

final class ProbeSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.backgroundColor = UIColor(red: 0.05, green: 0.72, blue: 0.48, alpha: 1)
        window.rootViewController = ProbeViewController()
        self.window = window
        window.makeKeyAndVisible()
    }
}

final class ProbeViewController: UIViewController {
    override var prefersStatusBarHidden: Bool { false }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.05, green: 0.72, blue: 0.48, alpha: 1)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        DispatchQueue.main.async {
            guard let window = self.view.window,
                  let scene = window.windowScene,
                  let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
                return
            }
            let screen = window.screen
            let bounds = screen.bounds
            let safeArea = window.safeAreaInsets
            let statusBarHeight = scene.statusBarManager?.statusBarFrame.height ?? 0
            let profile: [String: Any] = [
                "points": ["width": bounds.width, "height": bounds.height],
                "scale": screen.nativeScale,
                "safeAreaInsetsPoints": ["top": safeArea.top, "bottom": safeArea.bottom],
                "statusBarHeightPoints": statusBarHeight
            ]
            do {
                let data = try JSONSerialization.data(withJSONObject: profile, options: [.sortedKeys])
                try data.write(to: documents.appendingPathComponent("screen-profile.json"), options: .atomic)
            } catch {
                NSLog("SCREEN_PROBE_WRITE_FAILED: %@", error.localizedDescription)
            }
        }
    }
}
