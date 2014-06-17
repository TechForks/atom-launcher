// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Shell = imports.gi.Shell;
const Lang = imports.lang;
const Signals = imports.signals;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const Atk = imports.gi.Atk;

const AppFavorites = imports.ui.appFavorites;
const BoxPointer = imports.ui.boxpointer;
const DND = imports.ui.dnd;
const IconGrid = imports.ui.iconGrid;
const Main = imports.ui.main;
const Overview = imports.ui.overview;
const OverviewControls = imports.ui.overviewControls;
const PopupMenu = imports.ui.popupMenu;
const Tweener = imports.ui.tweener;
const Workspace = imports.ui.workspace;
const Params = imports.misc.params;
const Util = imports.misc.util;
const AppDisplay = imports.ui.appDisplay;

function enable(){
    Main.overview.viewSelector.appDisplay._views[0].view._redisplay();
    Main.overview.viewSelector.appDisplay._views[1].view._redisplay();
}

let disable = enable;

const FreqAllView = new Lang.Class({
    Name: 'FreqAllView',
    Extends: AppDisplay.BaseAppView,

    _init: function() {
        this.parent({ usePagination: true }, null);
        this._scrollView = new St.ScrollView({ style_class: 'all-apps',
                                               x_expand: true,
                                               y_expand: true,
                                               x_fill: true,
                                               y_fill: false,
                                               reactive: true,
                                               y_align: St.Align.START });
        this.actor = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                     x_expand:true, y_expand:true });
        this.actor.add_actor(this._scrollView);

        this._scrollView.set_policy(Gtk.PolicyType.NEVER,
                                    Gtk.PolicyType.AUTOMATIC);
        // we are only using ScrollView for the fade effect, hide scrollbars
        this._scrollView.vscroll.hide();
        this._adjustment = this._scrollView.vscroll.adjustment;
        this._usage = Shell.AppUsage.get_default();
        this._usageItems = [];
        this._pageIndicators = new AppDisplay.PageIndicators();
        this._pageIndicators.connect('page-activated', Lang.bind(this,
            function(indicators, pageIndex) {
                this.goToPage(pageIndex);
            }));
        this._pageIndicators.actor.connect('scroll-event', Lang.bind(this, this._onScroll));
        this.actor.add_actor(this._pageIndicators.actor);

        this.folderIcons = [];

        this._stack = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        let box = new St.BoxLayout({ vertical: true });

        this._currentPage = 0;
        this._stack.add_actor(this._grid.actor);
        this._eventBlocker = new St.Widget({ x_expand: true, y_expand: true });
        this._stack.add_actor(this._eventBlocker);

        box.add_actor(this._stack);
        this._scrollView.add_actor(box);

        this._scrollView.connect('scroll-event', Lang.bind(this, this._onScroll));

        let panAction = new Clutter.PanAction({ interpolate: false });
        panAction.connect('pan', Lang.bind(this, this._onPan));
        panAction.connect('gesture-cancel', Lang.bind(this, this._onPanEnd));
        panAction.connect('gesture-end', Lang.bind(this, this._onPanEnd));
        this._panAction = panAction;
        this._scrollView.add_action(panAction);
        this._panning = false;
        this._clickAction = new Clutter.ClickAction();
        this._clickAction.connect('clicked', Lang.bind(this, function() {
            if (!this._currentPopup){
                return;
            }

            let [x, y] = this._clickAction.get_coords();
            let actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
            if (!this._currentPopup.actor.contains(actor)){
                this._currentPopup.popdown();
            }
        }));
        this._eventBlocker.add_action(this._clickAction);

        this._displayingPopup = false;

        this._availWidth = 0;
        this._availHeight = 0;

        Main.overview.connect('hidden', Lang.bind(this,
            function() {
                this.goToPage(0);
            }));
        this._grid.connect('space-opened', Lang.bind(this,
            function() {
                this._scrollView.get_effect('fade').enabled = false;
                this.emit('space-ready');
            }));
        this._grid.connect('space-closed', Lang.bind(this,
            function() {
                this._displayingPopup = false;
            }));

        this.actor.connect('notify::mapped', Lang.bind(this,
            function() {
                if (this.actor.mapped) {
                    this._keyPressEventId =
                        global.stage.connect('key-press-event',
                                             Lang.bind(this, this._onKeyPressEvent));
                } else {
                    if (this._keyPressEventId){
                        global.stage.disconnect(this._keyPressEventId);
                    }
                    this._keyPressEventId = 0;
                }
            }));

        this._redisplayWorkId = Main.initializeDeferredWork(this.actor, Lang.bind(this, this._redisplay));

        Shell.AppSystem.get_default().connect('installed-changed', Lang.bind(this, function() {
            Main.queueDeferredWork(this._redisplayWorkId);
        }));
        this._folderSettings = new Gio.Settings({ schema: 'org.gnome.desktop.app-folders' });
        this._folderSettings.connect('changed::folder-children', Lang.bind(this, function() {
            Main.queueDeferredWork(this._redisplayWorkId);
        }));
    },

    removeAll: function() {
        this.folderIcons = [];
        this.parent();
    },

    _itemNameChanged: function(item) {
        // If an item's name changed, we can pluck it out of where it's
        // supposed to be and reinsert it where it's sorted.
        if (this._usageItems.indexOf(item) < 0){
            return;
        }
        let oldIdx = this._allItems.indexOf(item);
        this._allItems.splice(oldIdx, 1);
        let newIdx = Util.insertSorted(this._allItems, item, this._compareItems);

        this._grid.removeItem(item);
        this._grid.addItem(item, newIdx);
    },

    _refilterApps: function() {
        this._allItems.forEach(function(icon) {
            if (icon instanceof AppDisplay.AppIcon){
                icon.actor.visible = true;
            }
        });

        this.folderIcons.forEach(Lang.bind(this, function(folder) {
            let folderApps = folder.getAppIds();
            folderApps.forEach(Lang.bind(this, function(appId) {
                let appIcon = this._items[appId];
                appIcon.actor.visible = false;
            }));
        }));
    },
    _loadApps: function() {
        let apps = Gio.AppInfo.get_all().filter(function(appInfo) {
            return appInfo.should_show();
        }).map(function(app) {
            return app.get_id();
        });

        let appSys = Shell.AppSystem.get_default();

        this._usage.get_most_used("").forEach(Lang.bind(this, function(app){
            let icon = new AppDisplay.AppIcon(appSys.lookup_app(app.get_id()));
            this.addFreqItem(icon);
        })); 

        let folders = this._folderSettings.get_strv('folder-children');
        folders.forEach(Lang.bind(this, function(id) {
            let path = this._folderSettings.path + 'folders/' + id + '/';
            let icon = new AppDisplay.FolderIcon(id, path, this);
            icon.connect('name-changed', Lang.bind(this, this._itemNameChanged));
            icon.connect('apps-changed', Lang.bind(this, this._refilterApps));
            this.addItem(icon);
            this.folderIcons.push(icon);
        }));

        apps.forEach(Lang.bind(this, function(appId) {
            let app = appSys.lookup_app(appId);
            let icon = new AppDisplay.AppIcon(app);
            if (this.isFreqItem(icon)){
                return;
            }
            this.addItem(icon);
        }));

        this.loadGrid();
        this._refilterApps();
    },

    addFreqItem: function(icon) {
        let id = icon.id;
        if (this._items[id] !== undefined){
            return;
        }
        this._usageItems.push(icon);
        this._items[id] = icon;
    },

    isFreqItem: function(icon) {
        for(var i=0; i<this._usageItems.length; i++){
            if (this._usageItems[i].id == icon.id){
                return true;
            }
        }
        return false;
    },

    loadGrid: function() {
        this._usageItems.forEach(Lang.bind(this, function(item) {
            global.log(item.name);
            this._grid.addItem(item);
        }));

        this._allItems.sort(this._compareItems);
        this._allItems.forEach(Lang.bind(this, function(item) {
            this._grid.addItem(item);
        }));
        this.emit('view-loaded');
    },

    getCurrentPageY: function() {
        return this._grid.getPageY(this._currentPage);
    },

    goToPage: function(pageNumber) {
        if(pageNumber < 0 || pageNumber > this._grid.nPages() - 1){
            return;
        }
        if (this._currentPage == pageNumber && this._displayingPopup && this._currentPopup){
            return;
        }
        if (this._displayingPopup && this._currentPopup){
            this._currentPopup.popdown();
        }

        let velocity;
        if (!this._panning){
            velocity = 0;
        } else {
            velocity = Math.abs(this._panAction.get_velocity(0)[2]);
        }
        // Tween the change between pages.
        // If velocity is not specified (i.e. scrolling with mouse wheel),
        // use the same speed regardless of original position
        // if velocity is specified, it's in pixels per milliseconds
        let diffToPage = this._diffToPage(pageNumber);
        let childBox = this._scrollView.get_allocation_box();
        let totalHeight = childBox.y2 - childBox.y1;
        let time;
        // Only take the velocity into account on page changes, otherwise
        // return smoothly to the current page using the default velocity
        if (this._currentPage != pageNumber) {
            let minVelocity = totalHeight / (AppDisplay.PAGE_SWITCH_TIME * 1000);
            velocity = Math.max(minVelocity, velocity);
            time = (diffToPage / velocity) / 1000;
        } else {
            time = AppDisplay.PAGE_SWITCH_TIME * diffToPage / totalHeight;
        }
        // When changing more than one page, make sure to not take
        // longer than PAGE_SWITCH_TIME
        time = Math.min(time, AppDisplay.PAGE_SWITCH_TIME);

        if (pageNumber < this._grid.nPages() && pageNumber >= 0) {
            this._currentPage = pageNumber;
            Tweener.addTween(this._adjustment,
                             { value: this._grid.getPageY(this._currentPage),
                               time: time,
                               transition: 'easeOutQuad' });
            this._pageIndicators.setCurrentPage(pageNumber);
        }
    },

    _diffToPage: function (pageNumber) {
        let currentScrollPosition = this._adjustment.value;
        return Math.abs(currentScrollPosition - this._grid.getPageY(pageNumber));
    },

    openSpaceForPopup: function(item, side, nRows) {
        this._updateIconOpacities(true);
        this._displayingPopup = true;
        this._grid.openExtraSpace(item, side, nRows);
    },

    _closeSpaceForPopup: function() {
        this._updateIconOpacities(false);
        this._scrollView.get_effect('fade').enabled = true;
        this._grid.closeExtraSpace();
    },

    _onScroll: function(actor, event) {
        if (this._displayingPopup){
            return Clutter.EVENT_STOP;
        }

        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.UP){
            this.goToPage(this._currentPage - 1);
        }else if (direction == Clutter.ScrollDirection.DOWN){
            this.goToPage(this._currentPage + 1);
        }

        return Clutter.EVENT_STOP;
    },

    _onPan: function(action) {
        if (this._displayingPopup){
            return false;
        }
        this._panning = true;
        this._clickAction.release();
        let [dist, dx, dy] = action.get_motion_delta(0);
        let adjustment = this._adjustment;
        adjustment.value -= (dy / this._scrollView.height) * adjustment.page_size;
        return false;
    },

    _onPanEnd: function(action) {
         if (this._displayingPopup){
            return;
         }
        let diffCurrentPage = this._diffToPage(this._currentPage);
        if (diffCurrentPage > this._scrollView.height * AppDisplay.PAGE_SWITCH_TRESHOLD) {
            if (action.get_velocity(0)[2] > 0){
                this.goToPage(this._currentPage - 1);
            } else {
                this.goToPage(this._currentPage + 1);
            }
        } else {
            this.goToPage(this._currentPage);
        }
        this._panning = false;
    },

    _onKeyPressEvent: function(actor, event) {
        if (this._displayingPopup){
            return Clutter.EVENT_STOP;
        }
        if (event.get_key_symbol() == Clutter.Page_Up) {
            this.goToPage(this._currentPage - 1);
            return Clutter.EVENT_STOP;
        } else if (event.get_key_symbol() == Clutter.Page_Down) {
            this.goToPage(this._currentPage + 1);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    },

    addFolderPopup: function(popup) {
        this._stack.add_actor(popup.actor);
        popup.connect('open-state-changed', Lang.bind(this,
            function(popup, isOpen) {
                this._eventBlocker.reactive = isOpen;
                this._currentPopup = isOpen ? popup : null;
                this._updateIconOpacities(isOpen);
                if(!isOpen){
                    this._closeSpaceForPopup();
                }
            }));
    },

    _keyFocusIn: function(icon) {
        let itemPage = this._grid.getItemPage(icon);
        this.goToPage(itemPage);
    },

    _updateIconOpacities: function(folderOpen) {
        for (let id in this._items) {
            let params, opacity;
            if (folderOpen && !this._items[id].actor.checked){
                opacity =  AppDisplay.INACTIVE_GRID_OPACITY;
            } else {
                opacity = 255;
            }
            params = { opacity: opacity,
                       time: AppDisplay.INACTIVE_GRID_OPACITY_ANIMATION_TIME,
                       transition: 'easeOutQuad' };
            Tweener.addTween(this._items[id].actor, params);
        }
    },

    // Called before allocation to calculate dynamic spacing
    adaptToSize: function(width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = 0;
        box.x2 = width;
        box.y1 = 0;
        box.y2 = height;
        box = this.actor.get_theme_node().get_content_box(box);
        box = this._scrollView.get_theme_node().get_content_box(box);
        box = this._grid.actor.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        let oldNPages = this._grid.nPages();

        this._grid.adaptToSize(availWidth, availHeight);

        let fadeOffset = Math.min(this._grid.topPadding,
                                  this._grid.bottomPadding);
        this._scrollView.update_fade_effect(fadeOffset, 0);
        this._scrollView.get_effect('fade').fade_edges = true;

        if (this._availWidth != availWidth || this._availHeight != availHeight || oldNPages != this._grid.nPages()) {
            this._adjustment.value = 0;
            Meta.later_add(Meta.LaterType.BEFORE_REDRAW, Lang.bind(this,
                function() {
                    this._pageIndicators.setNPages(this._grid.nPages());
                    this._pageIndicators.setCurrentPage(0);
                }));
        }

        this._availWidth = availWidth;
        this._availHeight = availHeight;
        // Update folder views
        for (let i = 0; i < this.folderIcons.length; i++)
            this.folderIcons[i].adaptToSize(availWidth, availHeight);
    }
});
Signals.addSignalMethods(FreqAllView.prototype);

