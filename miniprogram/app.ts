import { readState } from "./services/store";
App<IAppOption>({
  globalData: {},
  onLaunch() {
    readState();
  },
});
