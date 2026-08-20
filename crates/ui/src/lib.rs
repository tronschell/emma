mod agent_surface;
mod library;

pub use agent_surface::{
    AgentSurfaceState, AgentSurfaceView, ScreenRect, SurfacePreferences, agent_surface_bounds,
};
pub use emma_core::OverlayPlacement;
use gpui::actions;
pub use library::LibraryView;

actions!(
    emma,
    [
        ToggleAgentSurface,
        DismissAgentSurface,
        Analyze,
        ActivateFocused,
        FocusNext,
        FocusPrevious,
        NewThread,
        ShowThreads,
        ShowKnowledgeBase,
        SaveToKnowledgeBase,
        AnalyzeKnowledgePage
    ]
);
