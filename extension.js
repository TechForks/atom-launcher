const Me = imports.misc.extensionUtils.getCurrentExtension();
const ShellVersion = imports.misc.config.PACKAGE_VERSION.split(".").map(function (x) { return +x; })
let fv;
if (ShellVersion[1] === 12) {
    fv = Me.imports.freqView;
} else {
    fv = Me.imports.freqView10;
}
const FreqView = fv;
const St = imports.gi.St;
const Main = imports.ui.main;
const Tweener = imports.ui.tweener;

let freqAllView, prevAllView;


function init() {
}

function enable() {
    freqAllView = new FreqView.FreqAllView();
    prevAllView = Main.overview.viewSelector.appDisplay._views[1].view;
    Main.overview.viewSelector.appDisplay._views[1].view = freqAllView;
    Main.overview.viewSelector.appDisplay._views[0].view.actor.hide();
    Main.overview.viewSelector.appDisplay._viewStack.remove_actor(prevAllView.actor);
    Main.overview.viewSelector.appDisplay._viewStack.add_actor(freqAllView.actor);
    FreqView.enable();
    Main.overview.viewSelector.appDisplay._controls.hide();
}

function disable() {
    Main.overview.viewSelector.appDisplay._viewStack.remove_actor(freqAllView.actor);
    Main.overview.viewSelector.appDisplay._views[1].view = prevAllView;
    Main.overview.viewSelector.appDisplay._viewStack.add_actor(prevAllView.actor);
    freqAllView = null;
    FreqView.disable();
    Main.overview.viewSelector.appDisplay._controls.show();
}
