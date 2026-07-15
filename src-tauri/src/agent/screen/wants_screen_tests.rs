use super::wants_screen;

#[test]
fn screen_questions_trigger() {
    assert!(wants_screen("What's this error on my screen?"));
    assert!(wants_screen("Where do I click to export?"));
    assert!(wants_screen("Can you see this dialog?"));
    assert!(wants_screen("Point to the save button"));
}

#[test]
fn draw_and_teach_intents_trigger() {
    assert!(wants_screen("Can you draw that as an illustration?"));
    assert!(wants_screen("Teach me the Pythagorean theorem"));
    assert!(wants_screen("Sketch a triangle for me"));
    assert!(wants_screen("Draw a diagram of how this works"));
    assert!(wants_screen("Annotate the chart"));
}

#[test]
fn non_screen_prompts_do_not() {
    assert!(!wants_screen("Remind me to call Q at 3pm"));
    assert!(!wants_screen("Where is my meeting tomorrow?"));
    assert!(!wants_screen("What's shipping in o8?"));
}
